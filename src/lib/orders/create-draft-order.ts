import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { OrderParseItem, OrderParseResult } from "@/lib/ai/tasks/order-parse";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import {
  cancelAwaitingPaymentOrder,
  findAwaitingPaymentForThread,
} from "@/lib/orders/confirm-draft-order";
import { ORDER_STATUS } from "@/lib/orders/status";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Minimum per-item match_confidence (and overall gate) required before we
 * create/update a PENDING_CONFIRMATION draft. Anything short falls through
 * to clarification — better to ask than to guess.
 */
export const CONFIRM_THRESHOLD = 0.7;

export type DraftOrderOutcome =
  | {
      action: "ignored";
      reason: "not_order_intent" | "empty_items";
    }
  | {
      action: "clarification_sent";
      message: string;
      outboundMessageId: string;
    }
  | {
      action: "stock_shortage";
      message: string;
      outboundMessageId: string;
      shortages: StockShortage[];
    }
  | {
      action: "draft_created" | "draft_updated";
      orderId: string;
      orderRef: string;
      totalPence: number;
      outboundMessageId: string;
      confirmationMessage: string;
      /** Set when an unpaid AWAITING_PAYMENT order was cancelled to make room. */
      supersededOrderId?: string;
    };

export interface CreateDraftOrderParams {
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string;
  parseResult: OrderParseResult;
  supabase?: SupabaseClient;
}

interface StockShortage {
  productName: string;
  variantLabel: string | null;
  requested: number;
  available: number;
}

interface ResolvedLine {
  productId: string;
  variantId: string;
  productName: string;
  variantLabel: string | null;
  quantity: number;
  unitPricePence: number;
  matchConfidence: number;
  trackInventory: boolean;
  available: number;
}

/**
 * Turn a stored order_parse result into either a PENDING_CONFIRMATION draft
 * (with a confirmation WhatsApp) or a clarification/stock message — never a
 * confirmed order or payment. An existing PENDING_CONFIRMATION on the thread
 * is updated in place (case-d corrections). An existing AWAITING_PAYMENT
 * order is cancelled/expired and replaced with a fresh draft.
 */
export async function createDraftOrderFromParse(
  params: CreateDraftOrderParams,
): Promise<DraftOrderOutcome> {
  const supabase = params.supabase ?? createAdminClient();
  const parse = params.parseResult;

  if (parse.intent === "question" || parse.intent === "other") {
    return { action: "ignored", reason: "not_order_intent" };
  }

  if (parse.intent !== "order") {
    return { action: "ignored", reason: "not_order_intent" };
  }

  if (!parse.items.length) {
    return { action: "ignored", reason: "empty_items" };
  }

  const gate = await evaluateConfirmGate(supabase, params.businessId, parse);
  if (!gate.ok) {
    const message =
      parse.clarification_message?.trim() ||
      gate.fallbackMessage ||
      "Sorry — I wasn't sure which items you wanted. Could you tell me the product name and size/colour again?";
    const sent = await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: params.customerPhoneE164,
      text: message,
      threadId: params.threadId,
      customerId: params.customerId,
      supabase,
    });
    return {
      action: "clarification_sent",
      message,
      outboundMessageId: sent.messageId,
    };
  }

  const shortages = gate.lines.filter(
    (line) => line.trackInventory && line.available < line.quantity,
  );
  if (shortages.length > 0) {
    const message = formatStockShortageMessage(shortages);
    const sent = await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: params.customerPhoneE164,
      text: message,
      threadId: params.threadId,
      customerId: params.customerId,
      supabase,
    });
    return {
      action: "stock_shortage",
      message,
      outboundMessageId: sent.messageId,
      shortages: shortages.map((line) => ({
        productName: line.productName,
        variantLabel: line.variantLabel,
        requested: line.quantity,
        available: line.available,
      })),
    };
  }

  const totalPence = gate.lines.reduce(
    (sum, line) => sum + line.unitPricePence * line.quantity,
    0,
  );

  const existing = await findPendingDraft(
    supabase,
    params.businessId,
    params.threadId,
  );

  let orderId: string;
  let orderRef: string;
  let action: "draft_created" | "draft_updated";
  let supersededOrderId: string | undefined;

  if (existing) {
    orderId = existing.id;
    orderRef = existing.order_ref;
    action = "draft_updated";

    const { error: deleteError } = await supabase
      .from("order_items")
      .delete()
      .eq("order_id", orderId);
    if (deleteError) {
      throw new Error(`Failed to clear draft items: ${deleteError.message}`);
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        total_pence: totalPence,
        ai_parse_confidence: parse.confidence,
        customer_id: params.customerId,
        channel: "whatsapp",
        status: ORDER_STATUS.PENDING_CONFIRMATION,
      })
      .eq("id", orderId);
    if (updateError) {
      throw new Error(`Failed to update draft order: ${updateError.message}`);
    }

    await insertStatusHistory(supabase, {
      orderId,
      businessId: params.businessId,
      fromStatus: ORDER_STATUS.PENDING_CONFIRMATION,
      toStatus: ORDER_STATUS.PENDING_CONFIRMATION,
    });
  } else {
    const awaiting = await findAwaitingPaymentForThread(
      supabase,
      params.businessId,
      params.threadId,
    );
    if (awaiting) {
      const cancelled = await cancelAwaitingPaymentOrder({
        supabase,
        businessId: params.businessId,
        orderId: awaiting.id,
        notifyBuyer: false,
      });
      if (cancelled.action === "error") {
        throw new Error(
          `Failed to supersede unpaid order: ${cancelled.error}`,
        );
      }
      supersededOrderId = awaiting.id;
    }

    orderRef = generateOrderRef();
    const { data: created, error: createError } = await supabase
      .from("orders")
      .insert({
        business_id: params.businessId,
        customer_id: params.customerId,
        channel: "whatsapp",
        status: ORDER_STATUS.PENDING_CONFIRMATION,
        ai_parse_confidence: parse.confidence,
        total_pence: totalPence,
        order_ref: orderRef,
        thread_id: params.threadId,
      })
      .select("id")
      .single();
    if (createError || !created) {
      throw new Error(
        `Failed to create draft order: ${createError?.message ?? "no row"}`,
      );
    }
    orderId = created.id;
    action = "draft_created";

    await insertStatusHistory(supabase, {
      orderId,
      businessId: params.businessId,
      fromStatus: null,
      toStatus: ORDER_STATUS.PENDING_CONFIRMATION,
    });
  }

  const itemRows = gate.lines.map((line) => ({
    order_id: orderId,
    business_id: params.businessId,
    product_variant_id: line.variantId,
    quantity: line.quantity,
    unit_price_pence: line.unitPricePence,
  }));

  const { error: itemsError } = await supabase
    .from("order_items")
    .insert(itemRows);
  if (itemsError) {
    throw new Error(`Failed to insert order items: ${itemsError.message}`);
  }

  const confirmationMessage = formatConfirmationMessage(gate.lines, totalPence);
  const sent = await sendWhatsAppMessage({
    businessId: params.businessId,
    toPhoneE164: params.customerPhoneE164,
    text: confirmationMessage,
    threadId: params.threadId,
    customerId: params.customerId,
    supabase,
  });

  console.info("[orders] Draft confirmation sent", {
    action,
    orderId,
    orderRef,
    totalPence,
    outboundMessageId: sent.messageId,
  });

  return {
    action,
    orderId,
    orderRef,
    totalPence,
    outboundMessageId: sent.messageId,
    confirmationMessage,
    ...(supersededOrderId ? { supersededOrderId } : {}),
  };
}

async function evaluateConfirmGate(
  supabase: SupabaseClient,
  businessId: string,
  parse: OrderParseResult,
): Promise<
  | { ok: true; lines: ResolvedLine[] }
  | { ok: false; fallbackMessage: string }
> {
  if (parse.needs_clarification) {
    return {
      ok: false,
      fallbackMessage:
        "I need a bit more detail before I can prepare that order — which product and size/colour did you want?",
    };
  }

  if (parse.confidence < CONFIRM_THRESHOLD) {
    return {
      ok: false,
      fallbackMessage:
        "I wasn't confident enough to prepare that order. Could you rephrase the items you want?",
    };
  }

  const lines: ResolvedLine[] = [];

  for (const item of parse.items) {
    const resolved = await resolveLine(supabase, businessId, item);
    if (!resolved.ok) {
      return { ok: false, fallbackMessage: resolved.fallbackMessage };
    }
    lines.push(resolved.line);
  }

  return { ok: true, lines };
}

async function resolveLine(
  supabase: SupabaseClient,
  businessId: string,
  item: OrderParseItem,
): Promise<
  | { ok: true; line: ResolvedLine }
  | { ok: false; fallbackMessage: string }
> {
  if (!item.matched_product_id) {
    return {
      ok: false,
      fallbackMessage: `I couldn't match "${item.product_query}" to anything in our catalogue. Which product did you mean?`,
    };
  }
  if (item.match_confidence < CONFIRM_THRESHOLD) {
    return {
      ok: false,
      fallbackMessage: `I wasn't sure about "${item.product_query}". Could you confirm the exact product name?`,
    };
  }

  const { data: product, error: productError } = await supabase
    .from("products")
    .select(
      "id, name, price_pence, active, deleted_at, product_variants(id, label, stock_quantity, reserved_quantity, track_inventory, deleted_at)",
    )
    .eq("id", item.matched_product_id)
    .eq("business_id", businessId)
    .maybeSingle();

  if (productError || !product || product.deleted_at || !product.active) {
    return {
      ok: false,
      fallbackMessage: `I couldn't find "${item.product_query}" in our catalogue right now. Could you pick something else?`,
    };
  }

  const variants = (
    (product.product_variants as Array<{
      id: string;
      label: string | null;
      stock_quantity: number;
      reserved_quantity: number;
      track_inventory: boolean;
      deleted_at: string | null;
    }> | null) ?? []
  ).filter((variant) => !variant.deleted_at);

  let variant = item.matched_variant_id
    ? variants.find((v) => v.id === item.matched_variant_id)
    : undefined;

  // Products with variants require an explicit matched variant.
  if (variants.length > 0 && !variant) {
    if (variants.length === 1 && !item.matched_variant_id) {
      variant = variants[0];
    } else {
      return {
        ok: false,
        fallbackMessage: `Which option of ${product.name} did you want${variants.length ? ` (${variants.map((v) => v.label).join(", ")})` : ""}?`,
      };
    }
  }

  if (!variant) {
    return {
      ok: false,
      fallbackMessage: `I couldn't resolve a purchasable option for ${product.name}.`,
    };
  }

  const quantity =
    typeof item.quantity === "number" && item.quantity > 0
      ? Math.floor(item.quantity)
      : 1;
  const available = Math.max(
    0,
    (variant.stock_quantity ?? 0) - (variant.reserved_quantity ?? 0),
  );

  return {
    ok: true,
    line: {
      productId: product.id as string,
      variantId: variant.id,
      productName: product.name as string,
      variantLabel: variant.label,
      quantity,
      unitPricePence: product.price_pence as number,
      matchConfidence: item.match_confidence,
      trackInventory: variant.track_inventory === true,
      available,
    },
  };
}

async function findPendingDraft(
  supabase: SupabaseClient,
  businessId: string,
  threadId: string,
): Promise<{ id: string; order_ref: string } | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_ref")
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .eq("status", ORDER_STATUS.PENDING_CONFIRMATION)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(`Draft lookup failed: ${error.message}`);
  }
  return data;
}

async function insertStatusHistory(
  supabase: SupabaseClient,
  params: {
    orderId: string;
    businessId: string;
    fromStatus: string | null;
    toStatus: string;
  },
) {
  const { error } = await supabase.from("order_status_history").insert({
    order_id: params.orderId,
    business_id: params.businessId,
    from_status: params.fromStatus,
    to_status: params.toStatus,
  });
  if (error) {
    console.error("[orders] Failed to write status history", error.message);
  }
}

function generateOrderRef(): string {
  return `TF-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function formatConfirmationMessage(
  lines: ResolvedLine[],
  totalPence: number,
): string {
  const itemLines = lines.map((line) => {
    const label = line.variantLabel ? ` (${line.variantLabel})` : "";
    const lineTotal = formatPence(line.unitPricePence * line.quantity);
    return `• ${line.quantity}× ${line.productName}${label} — ${lineTotal}`;
  });

  return [
    "Here's your draft order:",
    ...itemLines,
    "",
    `Total: ${formatPence(totalPence)}`,
    "",
    "Reply YES to confirm and pay, or tell us what to change.",
  ].join("\n");
}

function formatStockShortageMessage(lines: ResolvedLine[]): string {
  const details = lines
    .filter((line) => line.trackInventory && line.available < line.quantity)
    .map((line) => {
      const label = line.variantLabel ? ` (${line.variantLabel})` : "";
      if (line.available <= 0) {
        return `• ${line.productName}${label} is out of stock`;
      }
      return `• ${line.productName}${label}: only ${line.available} left (you asked for ${line.quantity})`;
    });

  return [
    "Sorry — we don't have enough stock for that order right now:",
    ...details,
    "",
    "Want a smaller quantity, or a different item?",
  ].join("\n");
}

/**
 * Buyer-facing draft/clarification text the live pipeline would send, without
 * creating an order or sending WhatsApp.
 */
export async function previewDraftBuyerReply(
  supabase: SupabaseClient,
  businessId: string,
  parse: OrderParseResult,
): Promise<{
  action: "ignored" | "clarification" | "stock_shortage" | "draft_confirmation";
  reply: string | null;
}> {
  if (parse.intent !== "order") {
    return { action: "ignored", reply: null };
  }
  if (!parse.items.length) {
    return { action: "ignored", reply: null };
  }

  const gate = await evaluateConfirmGate(supabase, businessId, parse);
  if (!gate.ok) {
    return {
      action: "clarification",
      reply:
        parse.clarification_message?.trim() ||
        gate.fallbackMessage ||
        "Sorry — I wasn't sure which items you wanted. Could you tell me the product name and size/colour again?",
    };
  }

  const shortages = gate.lines.filter(
    (line) => line.trackInventory && line.available < line.quantity,
  );
  if (shortages.length > 0) {
    return {
      action: "stock_shortage",
      reply: formatStockShortageMessage(shortages),
    };
  }

  const totalPence = gate.lines.reduce(
    (sum, line) => sum + line.unitPricePence * line.quantity,
    0,
  );
  return {
    action: "draft_confirmation",
    reply: formatConfirmationMessage(gate.lines, totalPence),
  };
}
