import type { SupabaseClient } from "@supabase/supabase-js";

import { ORDER_STATUS } from "@/lib/orders/status";
import type { OrderShippingAddress } from "@/lib/orders/shipping-address";
import {
  DEFAULT_WEIGHT_GRAMS,
  ShippoClientError,
  createShipment,
  type ShippoAddress,
  type ShippoRate,
} from "@/lib/shippo/client";

export class DispatchPrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchPrepError";
  }
}

export interface QuotedShippingRate {
  objectId: string;
  carrier: string;
  service: string;
  amount: string;
  currency: string;
  estimatedDays: number | null;
}

export interface ShippingRatesResult {
  shipmentId: string;
  weightGrams: number;
  rates: QuotedShippingRate[];
}

const RATE_LIMIT = 4;
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

function assertUkPostcode(value: string, kind: "delivery" | "dispatch") {
  if (!UK_POSTCODE.test(value.trim())) {
    throw new DispatchPrepError(
      kind === "delivery"
        ? "The delivery postcode is not a valid UK postcode. The order was not dispatched."
        : "Your dispatch postcode is not a valid UK postcode. Update it in Settings.",
    );
  }
}

function asAddress(value: unknown): OrderShippingAddress | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const line1 = typeof row.line1 === "string" ? row.line1.trim() : "";
  if (!line1) return null;
  return {
    line1,
    line2: typeof row.line2 === "string" && row.line2.trim() ? row.line2.trim() : null,
    city: typeof row.city === "string" && row.city.trim() ? row.city.trim() : null,
    postcode:
      typeof row.postcode === "string" && row.postcode.trim()
        ? row.postcode.trim()
        : null,
    country:
      typeof row.country === "string" && row.country.trim()
        ? row.country.trim()
        : null,
  };
}

function toShippoAddress(
  name: string,
  address: {
    street1: string;
    street2?: string | null;
    city: string;
    zip: string;
    country: string;
  },
): ShippoAddress {
  return {
    name,
    street1: address.street1,
    ...(address.street2 ? { street2: address.street2 } : {}),
    city: address.city,
    zip: address.zip,
    country: address.country,
  };
}

function validationError(
  results: { is_valid?: boolean; messages?: Array<{ text?: string }> } | undefined,
  fallback: string,
): string | null {
  if (!results || results.is_valid !== false) return null;
  const hint = (results.messages ?? [])
    .map((message) => message.text)
    .filter(Boolean)
    .join(" ");
  return hint || fallback;
}

function mapRate(rate: ShippoRate): QuotedShippingRate {
  return {
    objectId: rate.object_id,
    carrier: rate.provider || "Carrier",
    service: rate.servicelevel?.name?.trim() || "Service",
    amount: rate.amount,
    currency: rate.currency || "GBP",
    estimatedDays:
      typeof rate.estimated_days === "number" ? rate.estimated_days : null,
  };
}

export async function quoteShippingRates(
  supabase: SupabaseClient,
  orderId: string,
): Promise<ShippingRatesResult> {
  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, status, business_id, shipping_address, customer_id, customers(name)",
    )
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!order) throw new DispatchPrepError("Order not found");
  if (order.status !== ORDER_STATUS.PAID) {
    throw new DispatchPrepError(
      `Cannot get shipping rates for an order in status ${order.status}`,
    );
  }

  const shipping = asAddress(order.shipping_address);
  if (!shipping?.city || !shipping.postcode) {
    throw new DispatchPrepError(
      "This order has no delivery address. The buyer must complete Checkout with a shipping address before dispatch.",
    );
  }
  assertUkPostcode(shipping.postcode, "delivery");

  const { data: business, error: bizError } = await supabase
    .from("businesses")
    .select("id, name, dispatch_address_line1, dispatch_city, dispatch_postcode")
    .eq("id", order.business_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (bizError) throw new Error(bizError.message);
  if (
    !business?.dispatch_address_line1?.trim() ||
    !business.dispatch_city?.trim() ||
    !business.dispatch_postcode?.trim()
  ) {
    throw new DispatchPrepError(
      "Set your dispatch address in Settings before buying a shipping label.",
    );
  }
  assertUkPostcode(business.dispatch_postcode.trim(), "dispatch");

  const { data: items, error: itemError } = await supabase
    .from("order_items")
    .select("quantity, product_variants(weight_grams)")
    .eq("order_id", orderId);
  if (itemError) throw new Error(itemError.message);
  if (!items?.length) {
    throw new DispatchPrepError("This order has no line items to ship.");
  }

  let weightGrams = 0;
  for (const item of items) {
    const raw = item.product_variants as unknown;
    const variant = (Array.isArray(raw) ? raw[0] : raw) as {
      weight_grams?: number | null;
    } | null;
    const unit = variant?.weight_grams ?? DEFAULT_WEIGHT_GRAMS;
    weightGrams += Math.max(1, unit) * (item.quantity as number);
  }

  const customerRaw = (order as { customers?: unknown }).customers;
  const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  const toName =
    (customer && typeof customer === "object" && "name" in customer
      ? String((customer as { name?: string | null }).name ?? "").trim()
      : "") || "Customer";

  const shipment = await createShipment({
    addressFrom: toShippoAddress(business.name as string, {
      street1: business.dispatch_address_line1.trim(),
      city: business.dispatch_city.trim(),
      zip: business.dispatch_postcode.trim(),
      country: "GB",
    }),
    addressTo: toShippoAddress(toName, {
      street1: shipping.line1,
      street2: shipping.line2,
      city: shipping.city,
      zip: shipping.postcode,
      country: (shipping.country || "GB").toUpperCase(),
    }),
    weightGrams,
  });

  if (!shipment.object_id) {
    throw new ShippoClientError(
      "Shippo did not create a shipment. Check the delivery and dispatch addresses and try again.",
    );
  }

  const rawRates = [...(shipment.rates ?? [])].sort(
    (a, b) => Number.parseFloat(a.amount) - Number.parseFloat(b.amount),
  );
  const rates = rawRates.slice(0, RATE_LIMIT).map(mapRate);

  const fromInvalid = validationError(
    shipment.address_from?.validation_results,
    "Your dispatch address could not be validated. Update it in Settings and try again.",
  );
  const toInvalid = validationError(
    shipment.address_to?.validation_results,
    "The delivery address could not be validated. The order was not dispatched.",
  );
  if (rates.length === 0) {
    const hint = (shipment.messages ?? [])
      .map((message) => message.text)
      .filter(Boolean)
      .join(" ");
    throw new ShippoClientError(
      fromInvalid ||
        toInvalid ||
        hint ||
        "No shipping rates returned. Check the delivery and dispatch addresses and try again.",
    );
  }

  return {
    shipmentId: shipment.object_id,
    weightGrams,
    rates,
  };
}
