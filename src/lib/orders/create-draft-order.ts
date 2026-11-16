import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { OrderParseItem, OrderParseResult } from "@/lib/ai/tasks/order-parse";
import { enqueuePendingReplay } from "@/lib/channels/pending-replay";
import { buildDraftItemSignature } from "@/lib/channels/send/delivery";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { withReplyPrefix } from "@/lib/channels/voice-note";
import { t } from "@/lib/i18n";
import { getCustomerPreferredLanguage } from "@/lib/i18n/language";
import {
  cancelAwaitingPaymentOrder,
  findAwaitingPaymentForThread,
} from "@/lib/orders/confirm-draft-order";
import { ORDER_STATUS } from "@/lib/orders/status";
import { canAcceptOrders } from "@/lib/stripe/billing-gate";
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
      reason: "not_order_intent" | "empty_items" | "shop_unavailable";
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
      /** Present when Twilio (or persist) rejected the confirmation send. */
      sendError?: string;
      /** Set when an unpaid AWAITING_PAYMENT order was cancelled to make room. */
      supersededOrderId?: string;
    };

export interface CreateDraftOrderParams {
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string;
  parseResult: OrderParseResult;
  /** Optional transparency prefix (e.g. voice-note "I heard: … — "). */
  buyerReplyPrefix?: string | null;
  supabase?: SupabaseClient;
  /** Inbound message that produced this draft — used to queue replay. */
  inboundMessageId?: string | null;
  /** When true, caller owns the pending_replay row (replay cron). */
  skipReplayEnqueue?: boolean;
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

  const { data: billing } = await supabase
    .from("businesses")
    .select("stripe_subscription_status, closed_at, dispute_balance_hold")
    .eq("id", params.businessId)
    .is("deleted_at", null)
    .maybeSingle();
  if (
    !canAcceptOrders({
      stripe_subscription_status:
        (billing?.stripe_subscription_status as string | null) ?? null,
      closed_at: (billing?.closed_at as string | null) ?? null,
      dispute_balance_hold:
        (billing?.dispute_balance_hold as boolean | null) ?? false,
    })
  ) {
    return { action: "ignored", reason: "shop_unavailable" };
  }

  if (parse.intent === "question" || parse.intent === "other") {
    return { action: "ignored", reason: "not_order_intent" };
  }

  if (parse.intent !== "order") {
    return { action: "ignored", reason: "not_order_intent" };
  }

  if (!parse.items.length) {
    return { action: "ignored", reason: "empty_items" };
  }

  const replyPrefix = params.buyerReplyPrefix ?? null;
  const lang = await getCustomerPreferredLanguage(supabase, params.customerId);

  const gate = await evaluateConfirmGate(supabase, params.businessId, parse, lang);
  if (!gate.ok) {
    const message = withReplyPrefix(
      replyPrefix,
      parse.clarification_message?.trim() ||
        gate.fallbackMessage ||
        t("draft.clarification_unsure", lang),
    );
    try {
      const sent = await sendWhatsAppMessage({
        businessId: params.businessId,
        toPhoneE164: params.customerPhoneE164,
        text: message,
        threadId: params.threadId,
        customerId: params.customerId,
        supabase,
        audience: "buyer",
        scheduleOutboundRetry: false,
      });
      return {
        action: "clarification_sent",
        message,
        outboundMessageId: sent.messageId,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("[orders] Clarification send failed (persisted)", {
        error: err,
      });
      if (params.inboundMessageId && !params.skipReplayEnqueue) {
        await enqueuePendingReplay({
          supabase,
          inboundMessageId: params.inboundMessageId,
          businessId: params.businessId,
          customerId: params.customerId,
          threadId: params.threadId,
          lastError: err,
        }).catch(() => undefined);
      }
      return {
        action: "clarification_sent",
        message,
        outboundMessageId: "",
      };
    }
  }

  const shortages = gate.lines.filter(
    (line) => line.trackInventory && line.available < line.quantity,
  );
  if (shortages.length > 0) {
    const message = withReplyPrefix(
      replyPrefix,
      formatStockShortageMessage(shortages, lang),
    );
    try {
      const sent = await sendWhatsAppMessage({
        businessId: params.businessId,
        toPhoneE164: params.customerPhoneE164,
        text: message,
        threadId: params.threadId,
        customerId: params.customerId,
        supabase,
        audience: "buyer",
        scheduleOutboundRetry: false,
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
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("[orders] Stock shortage send failed (persisted)", {
        error: err,
      });
      if (params.inboundMessageId && !params.skipReplayEnqueue) {
        await enqueuePendingReplay({
          supabase,
          inboundMessageId: params.inboundMessageId,
          businessId: params.businessId,
          customerId: params.customerId,
          threadId: params.threadId,
          lastError: err,
        }).catch(() => undefined);
      }
      return {
        action: "stock_shortage",
        message,
        outboundMessageId: "",
        shortages: shortages.map((line) => ({
          productName: line.productName,
          variantLabel: line.variantLabel,
          requested: line.quantity,
          available: line.available,
        })),
      };
    }
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
  /** Snapshot so a failed confirmation can restore what the buyer last saw. */
  let previousDraft: {
    totalPence: number;
    items: Array<{
      product_variant_id: string;
      quantity: number;
      unit_price_pence: number;
    }>;
  } | null = null;

  if (existing) {
    orderId = existing.id;
    orderRef = existing.order_ref;
    action = "draft_updated";

    const { data: priorItems } = await supabase
      .from("order_items")
      .select("product_variant_id, quantity, unit_price_pence")
      .eq("order_id", orderId);
    previousDraft = {
      totalPence: existing.total_pence,
      items: (priorItems ?? []).map((row) => ({
        product_variant_id: row.product_variant_id as string,
        quantity: row.quantity as number,
        unit_price_pence: row.unit_price_pence as number,
      })),
    };

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

  const confirmationMessage = withReplyPrefix(
    replyPrefix,
    formatConfirmationMessage(gate.lines, totalPence, lang),
  );
  const templateItems = gate.lines
    .map((line) => {
      const label = line.variantLabel ? ` (${line.variantLabel})` : "";
      return `${line.quantity}× ${line.productName}${label}`;
    })
    .join(", ");

  let outboundMessageId = "";
  let sendError: string | undefined;
  try {
    const sent = await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: params.customerPhoneE164,
      text: confirmationMessage,
      threadId: params.threadId,
      customerId: params.customerId,
      supabase,
      audience: "buyer",
      scheduleOutboundRetry: false,
      templateLanguage: lang,
      template: {
        key: "order_confirmation_needed",
        variables: {
          items: templateItems,
          total: formatPence(totalPence),
        },
      },
      retryContext: {
        kind: "draft_confirmation",
        orderId,
        orderRef,
        totalPence,
        itemSignature: buildDraftItemSignature(
          itemRows.map((row) => ({
            product_variant_id: row.product_variant_id,
            quantity: row.quantity,
            unit_price_pence: row.unit_price_pence,
          })),
        ),
      },
    });
    outboundMessageId = sent.messageId;
    console.info("[orders] Draft confirmation sent", {
      action,
      orderId,
      orderRef,
      totalPence,
      outboundMessageId: sent.messageId,
      deliveryStatus: sent.deliveryStatus,
    });
  } catch (error) {
    sendError = error instanceof Error ? error.message : String(error);
    console.error("[orders] Draft confirmation send failed — reverting draft", {
      action,
      orderId,
      orderRef,
      error: sendError,
    });
    await revertUndeliveredDraft(supabase, {
      action,
      orderId,
      businessId: params.businessId,
      previousDraft,
    });
    if (params.inboundMessageId && !params.skipReplayEnqueue) {
      try {
        await enqueuePendingReplay({
          supabase,
          inboundMessageId: params.inboundMessageId,
          businessId: params.businessId,
          customerId: params.customerId,
          threadId: params.threadId,
          lastError: sendError,
          delayMinutes: 30,
        });
      } catch (enqueueError) {
        console.error("[orders] pending_replay enqueue failed", {
          inboundMessageId: params.inboundMessageId,
          error:
            enqueueError instanceof Error
              ? enqueueError.message
              : String(enqueueError),
        });
      }
    }
  }

  return {
    action,
    orderId,
    orderRef,
    // After revert, report the totals the buyer still has (previous) when
    // an update failed; otherwise the new totals.
    totalPence:
      sendError && previousDraft ? previousDraft.totalPence : totalPence,
    outboundMessageId,
    confirmationMessage,
    ...(sendError ? { sendError } : {}),
    ...(supersededOrderId ? { supersededOrderId } : {}),
  };
}

/**
 * Keep draft state aligned with what the buyer last received.
 * - draft_updated + failed send → restore previous items/total
 * - draft_created + failed send → cancel the unseen draft
 */
async function revertUndeliveredDraft(
  supabase: SupabaseClient,
  params: {
    action: "draft_created" | "draft_updated";
    orderId: string;
    businessId: string;
    previousDraft: {
      totalPence: number;
      items: Array<{
        product_variant_id: string;
        quantity: number;
        unit_price_pence: number;
      }>;
    } | null;
  },
): Promise<void> {
  if (params.action === "draft_updated" && params.previousDraft) {
    await supabase.from("order_items").delete().eq("order_id", params.orderId);
    if (params.previousDraft.items.length) {
      await supabase.from("order_items").insert(
        params.previousDraft.items.map((item) => ({
          order_id: params.orderId,
          business_id: params.businessId,
          product_variant_id: item.product_variant_id,
          quantity: item.quantity,
          unit_price_pence: item.unit_price_pence,
        })),
      );
    }
    await supabase
      .from("orders")
      .update({
        total_pence: params.previousDraft.totalPence,
        status: ORDER_STATUS.PENDING_CONFIRMATION,
      })
      .eq("id", params.orderId);
    console.info("[orders] Reverted draft to last delivered contents", {
      orderId: params.orderId,
      totalPence: params.previousDraft.totalPence,
      itemCount: params.previousDraft.items.length,
    });
    return;
  }

  if (params.action === "draft_created") {
    await supabase.from("order_items").delete().eq("order_id", params.orderId);
    await supabase
      .from("orders")
      .update({ status: ORDER_STATUS.CANCELLED })
      .eq("id", params.orderId);
    await insertStatusHistory(supabase, {
      orderId: params.orderId,
      businessId: params.businessId,
      fromStatus: ORDER_STATUS.PENDING_CONFIRMATION,
      toStatus: ORDER_STATUS.CANCELLED,
    });
    console.info("[orders] Cancelled undelivered new draft", {
      orderId: params.orderId,
    });
  }
}

async function evaluateConfirmGate(
  supabase: SupabaseClient,
  businessId: string,
  parse: OrderParseResult,
  lang: string,
): Promise<
  | { ok: true; lines: ResolvedLine[] }
  | { ok: false; fallbackMessage: string }
> {
  if (parse.needs_clarification) {
    return {
      ok: false,
      fallbackMessage: t("draft.clarification_need_detail", lang),
    };
  }

  if (parse.confidence < CONFIRM_THRESHOLD) {
    return {
      ok: false,
      fallbackMessage: t("draft.clarification_low_confidence", lang),
    };
  }

  const lines: ResolvedLine[] = [];

  for (const item of parse.items) {
    const resolved = await resolveLine(supabase, businessId, item, lang);
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
  lang: string,
): Promise<
  | { ok: true; line: ResolvedLine }
  | { ok: false; fallbackMessage: string }
> {
  if (!item.matched_product_id) {
    return {
      ok: false,
      fallbackMessage: t("draft.clarification_unmatched", lang, {
        query: item.product_query,
      }),
    };
  }
  if (item.match_confidence < CONFIRM_THRESHOLD) {
    return {
      ok: false,
      fallbackMessage: t("draft.clarification_confirm_product", lang, {
        query: item.product_query,
      }),
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
      fallbackMessage: t("draft.clarification_not_in_catalogue", lang, {
        query: item.product_query,
      }),
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
        fallbackMessage: t("draft.clarification_which_option", lang, {
          product: product.name as string,
          options: variants.map((v) => v.label).join(", "),
        }),
      };
    }
  }

  if (!variant) {
    return {
      ok: false,
      fallbackMessage: t("draft.clarification_no_option", lang, {
        product: product.name as string,
      }),
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
): Promise<{ id: string; order_ref: string; total_pence: number } | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_ref, total_pence")
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

export function generateOrderRef(): string {
  return `TF-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function formatConfirmationMessage(
  lines: ResolvedLine[],
  totalPence: number,
  lang: string,
): string {
  const items = lines
    .map((line) => {
      const label = line.variantLabel ? ` (${line.variantLabel})` : "";
      const lineTotal = formatPence(line.unitPricePence * line.quantity);
      return `• ${line.quantity}× ${line.productName}${label} — ${lineTotal}`;
    })
    .join("\n");

  return t("draft.confirmation", lang, {
    items,
    total: formatPence(totalPence),
  });
}

function formatStockShortageMessage(
  lines: ResolvedLine[],
  lang: string,
): string {
  const details = lines
    .filter((line) => line.trackInventory && line.available < line.quantity)
    .map((line) => {
      const label = line.variantLabel ? ` (${line.variantLabel})` : "";
      const name = `${line.productName}${label}`;
      if (line.available <= 0) {
        return t("draft.stock_out", lang, { name });
      }
      return t("draft.stock_partial", lang, {
        name,
        available: line.available,
        requested: line.quantity,
      });
    })
    .join("\n");

  return t("draft.stock_shortage", lang, { details });
}

/**
 * Buyer-facing draft/clarification text the live pipeline would send, without
 * creating an order or sending WhatsApp.
 */
export async function previewDraftBuyerReply(
  supabase: SupabaseClient,
  businessId: string,
  parse: OrderParseResult,
  lang: string = "en",
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

  const gate = await evaluateConfirmGate(supabase, businessId, parse, lang);
  if (!gate.ok) {
    return {
      action: "clarification",
      reply:
        parse.clarification_message?.trim() ||
        gate.fallbackMessage ||
        t("draft.clarification_unsure", lang),
    };
  }

  const shortages = gate.lines.filter(
    (line) => line.trackInventory && line.available < line.quantity,
  );
  if (shortages.length > 0) {
    return {
      action: "stock_shortage",
      reply: formatStockShortageMessage(shortages, lang),
    };
  }

  const totalPence = gate.lines.reduce(
    (sum, line) => sum + line.unitPricePence * line.quantity,
    0,
  );
  return {
    action: "draft_confirmation",
    reply: formatConfirmationMessage(gate.lines, totalPence, lang),
  };
}
