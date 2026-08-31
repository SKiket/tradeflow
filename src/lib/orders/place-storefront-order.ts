import type { SupabaseClient } from "@supabase/supabase-js";

import { findOrCreateCustomer } from "@/lib/channels/normaliser";
import { generateOrderRef } from "@/lib/orders/create-draft-order";
import { unwrapRelation } from "@/lib/orders/display";
import {
  checkLinesStockAvailable,
  incrementReservedQuantities,
  releaseOrderReservation,
  reservationExpiryDate,
  sweepExpiredReservations,
} from "@/lib/orders/reservations";
import { ORDER_STATUS } from "@/lib/orders/status";
import { createOrderCheckoutSession } from "@/lib/stripe/checkout";
import { parseBuyerPhone } from "@/lib/storefront/phone";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE_QTY = 99;
const MAX_LINES = 40;

export class PlaceStorefrontOrderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlaceStorefrontOrderError";
  }
}

export type StorefrontCheckoutItem = {
  variantId: string;
  quantity: number;
};

export type PlaceStorefrontOrderParams = {
  businessId: string;
  items: StorefrontCheckoutItem[];
  customerName: string;
  customerPhone: string;
  supabase?: SupabaseClient;
};

export type PlaceStorefrontOrderResult = {
  orderId: string;
  orderRef: string;
  checkoutUrl: string;
  checkoutSessionId: string;
  totalPence: number;
};

type ResolvedLine = {
  variantId: string;
  productName: string;
  variantLabel: string | null;
  quantity: number;
  unitPricePence: number;
};

type VariantJoin = {
  id: string;
  name: string;
  price_pence: number;
  active: boolean;
  deleted_at: string | null;
} | null;

/**
 * Structured storefront checkout: exact variant ids, no order_parse.
 * Creates AWAITING_PAYMENT directly (the form submit is the confirmation),
 * reserves stock for the same 24h window as WhatsApp confirm, then returns
 * a Stripe Checkout URL. thread_id stays null — no WhatsApp thread exists.
 */
export async function placeStorefrontOrder(
  params: PlaceStorefrontOrderParams,
): Promise<PlaceStorefrontOrderResult> {
  const supabase = params.supabase ?? createAdminClient();
  const businessId = params.businessId.trim();
  if (!UUID_RE.test(businessId)) {
    throw new PlaceStorefrontOrderError(
      "Invalid store.",
      400,
      "INVALID_BUSINESS",
    );
  }

  const customerName = params.customerName.trim();
  if (customerName.length < 1 || customerName.length > 80) {
    throw new PlaceStorefrontOrderError(
      "Enter your name.",
      400,
      "INVALID_NAME",
    );
  }

  const phone = parseBuyerPhone(params.customerPhone);
  if (!phone.ok) {
    throw new PlaceStorefrontOrderError(phone.error, 400, "INVALID_PHONE");
  }

  const merged = mergeItems(params.items);
  if (merged.length === 0) {
    throw new PlaceStorefrontOrderError(
      "Your cart is empty.",
      400,
      "EMPTY_CART",
    );
  }
  if (merged.length > MAX_LINES) {
    throw new PlaceStorefrontOrderError(
      "Too many items in the cart.",
      400,
      "CART_TOO_LARGE",
    );
  }

  const { data: business, error: bizError } = await supabase
    .from("businesses")
    .select("id, stripe_connected_account_id, stripe_charges_enabled")
    .eq("id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  if (bizError) {
    throw new PlaceStorefrontOrderError(
      "Could not load this store.",
      500,
      "BUSINESS_LOOKUP",
    );
  }
  if (!business) {
    throw new PlaceStorefrontOrderError("Store not found.", 404, "NOT_FOUND");
  }
  if (!business.stripe_connected_account_id) {
    throw new PlaceStorefrontOrderError(
      "This store isn't ready to accept card payments yet.",
      400,
      "STRIPE_NOT_CONFIGURED",
    );
  }
  if (!business.stripe_charges_enabled) {
    throw new PlaceStorefrontOrderError(
      "This store isn't ready to accept card payments yet.",
      400,
      "STRIPE_CHARGES_DISABLED",
    );
  }

  const lines = await loadPricedLines(supabase, businessId, merged);

  await sweepExpiredReservations(supabase, businessId);

  const stock = await checkLinesStockAvailable(
    supabase,
    lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
  );
  if (!stock.ok) {
    throw new PlaceStorefrontOrderError(
      formatShortageMessage(lines, stock.shortages),
      409,
      "STOCK_UNAVAILABLE",
      { shortages: stock.shortages },
    );
  }

  const customer = await findOrCreateCustomer(supabase, {
    businessId,
    phoneE164: phone.e164,
    name: customerName,
    channel: "storefront",
  });
  if (customer.status === "error") {
    throw new PlaceStorefrontOrderError(
      "Could not save your details. Please try again.",
      500,
      "CUSTOMER",
    );
  }

  const totalPence = lines.reduce(
    (sum, line) => sum + line.unitPricePence * line.quantity,
    0,
  );
  const expiresAt = reservationExpiryDate();
  const orderRef = generateOrderRef();

  const { data: created, error: createError } = await supabase
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customer.customerId,
      channel: "storefront",
      status: ORDER_STATUS.AWAITING_PAYMENT,
      total_pence: totalPence,
      order_ref: orderRef,
      thread_id: null,
      reserved_until: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (createError || !created) {
    throw new PlaceStorefrontOrderError(
      `Failed to create order: ${createError?.message ?? "no row"}`,
      500,
      "ORDER_CREATE",
    );
  }

  const orderId = created.id as string;

  const { error: itemsError } = await supabase.from("order_items").insert(
    lines.map((line) => ({
      order_id: orderId,
      business_id: businessId,
      product_variant_id: line.variantId,
      quantity: line.quantity,
      unit_price_pence: line.unitPricePence,
    })),
  );

  if (itemsError) {
    await supabase
      .from("orders")
      .update({ status: ORDER_STATUS.CANCELLED, reserved_until: null })
      .eq("id", orderId);
    throw new PlaceStorefrontOrderError(
      `Failed to save order items: ${itemsError.message}`,
      500,
      "ORDER_ITEMS",
    );
  }

  await incrementReservedQuantities(
    supabase,
    lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
  );

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: businessId,
    from_status: null,
    to_status: ORDER_STATUS.AWAITING_PAYMENT,
  });

  let session;
  try {
    session = await createOrderCheckoutSession({
      connectedAccountId: business.stripe_connected_account_id,
      orderId,
      orderRef,
      lineItems: lines.map((line) => ({
        name: line.variantLabel
          ? `${line.productName} (${line.variantLabel})`
          : line.productName,
        unitAmountPence: line.unitPricePence,
        quantity: line.quantity,
      })),
      expiresAtUnix: Math.floor(expiresAt.getTime() / 1000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[storefront] Checkout session creation failed", {
      orderId,
      message,
    });
    await releaseOrderReservation(supabase, orderId, ORDER_STATUS.CANCELLED);
    throw new PlaceStorefrontOrderError(
      `Checkout creation failed: ${message}`,
      500,
      "CHECKOUT_CREATE",
    );
  }

  if (!session.url) {
    await releaseOrderReservation(supabase, orderId, ORDER_STATUS.CANCELLED);
    throw new PlaceStorefrontOrderError(
      "Checkout session has no URL",
      500,
      "CHECKOUT_NO_URL",
    );
  }

  await supabase
    .from("orders")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", orderId);

  console.info("[storefront] Order placed", {
    orderId,
    orderRef,
    checkoutSessionId: session.id,
    totalPence,
  });

  return {
    orderId,
    orderRef,
    checkoutUrl: session.url,
    checkoutSessionId: session.id,
    totalPence,
  };
}

function mergeItems(items: StorefrontCheckoutItem[]): StorefrontCheckoutItem[] {
  const byVariant = new Map<string, number>();
  for (const item of items ?? []) {
    if (!item || typeof item !== "object") continue;
    const variantId = String(item.variantId ?? "").trim();
    if (!UUID_RE.test(variantId)) {
      throw new PlaceStorefrontOrderError(
        "Your cart contains an invalid item. Refresh the page and try again.",
        400,
        "INVALID_VARIANT",
      );
    }
    const quantity = Math.floor(Number(item.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) {
      throw new PlaceStorefrontOrderError(
        "Each item needs a quantity of at least 1.",
        400,
        "INVALID_QUANTITY",
      );
    }
    if (quantity > MAX_LINE_QTY) {
      throw new PlaceStorefrontOrderError(
        `Quantity cannot exceed ${MAX_LINE_QTY} per item.`,
        400,
        "QUANTITY_TOO_HIGH",
      );
    }
    byVariant.set(variantId, (byVariant.get(variantId) ?? 0) + quantity);
  }

  return [...byVariant.entries()].map(([variantId, quantity]) => {
    if (quantity > MAX_LINE_QTY) {
      throw new PlaceStorefrontOrderError(
        `Quantity cannot exceed ${MAX_LINE_QTY} per item.`,
        400,
        "QUANTITY_TOO_HIGH",
      );
    }
    return { variantId, quantity };
  });
}

async function loadPricedLines(
  supabase: SupabaseClient,
  businessId: string,
  items: StorefrontCheckoutItem[],
): Promise<ResolvedLine[]> {
  const ids = items.map((item) => item.variantId);
  const { data: rows, error } = await supabase
    .from("product_variants")
    .select(
      "id, label, deleted_at, products(id, name, price_pence, active, deleted_at)",
    )
    .eq("business_id", businessId)
    .in("id", ids);

  if (error) {
    throw new PlaceStorefrontOrderError(
      `Catalog lookup failed: ${error.message}`,
      500,
      "CATALOG_LOOKUP",
    );
  }

  const byId = new Map<
    string,
    {
      variantId: string;
      productName: string;
      variantLabel: string | null;
      unitPricePence: number;
    }
  >();

  for (const row of rows ?? []) {
    if (row.deleted_at) continue;
    const product = unwrapRelation(row.products as VariantJoin | VariantJoin[]);
    if (!product) continue;
    if (product.deleted_at || !product.active) continue;
    byId.set(row.id as string, {
      variantId: row.id as string,
      productName: product.name,
      variantLabel: (row.label as string | null) ?? null,
      unitPricePence: product.price_pence,
    });
  }

  if (byId.size !== items.length) {
    throw new PlaceStorefrontOrderError(
      "One or more items are no longer available. Refresh the catalog and try again.",
      409,
      "ITEMS_UNAVAILABLE",
    );
  }

  return items.map((item) => {
    const found = byId.get(item.variantId)!;
    return { ...found, quantity: item.quantity };
  });
}

function formatShortageMessage(
  lines: ResolvedLine[],
  shortages: Array<{ variantId: string; requested: number; available: number }>,
): string {
  const byId = new Map(lines.map((line) => [line.variantId, line]));
  const details = shortages.map((shortage) => {
    const line = byId.get(shortage.variantId);
    const name = line
      ? `${line.productName}${line.variantLabel ? ` (${line.variantLabel})` : ""}`
      : "an item";
    if (shortage.available <= 0) {
      return `${name} is out of stock`;
    }
    return `${name} only has ${shortage.available} left (you asked for ${shortage.requested})`;
  });
  return `Sorry — ${details.join("; ")}. Nothing was ordered.`;
}
