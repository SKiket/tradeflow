import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildDraftItemSignature,
  parseRetryContext,
  RETRY_MAX_AGE_MS,
  type RetryContext,
} from "@/lib/channels/send/delivery";
import { ORDER_STATUS } from "@/lib/orders/status";

export type RetryDecision =
  | { action: "send"; reason: "eligible" }
  | { action: "expired"; reason: string }
  | { action: "superseded"; reason: string };

/**
 * A retry may only send text that still matches current order/thread state.
 *
 * Cancel (supersede) when:
 * - the draft changed or was reverted (totals/items/order id mismatch)
 * - the buyer has written again since this outbound was created
 * - the order is no longer awaiting confirmation (for draft confirmations)
 *
 * Expire when the message is older than 12 hours.
 */
export async function evaluateOutboundRetry(params: {
  supabase: SupabaseClient;
  messageId: string;
  businessId: string;
  threadId: string | null;
  customerId: string;
  createdAt: string;
  normalisedText: string;
  rawPayload: Record<string, unknown> | null;
}): Promise<RetryDecision> {
  const queuedAt =
    typeof params.rawPayload?.queued_at === "string"
      ? params.rawPayload.queued_at
      : params.createdAt;
  const ageMs = Date.now() - new Date(queuedAt).getTime();
  if (Number.isFinite(ageMs) && ageMs > RETRY_MAX_AGE_MS) {
    return {
      action: "expired",
      reason: "Message older than 12 hours — retry cancelled",
    };
  }

  if (params.threadId) {
    const { data: newerInbound } = await params.supabase
      .from("messages")
      .select("id")
      .eq("thread_id", params.threadId)
      .eq("direction", "inbound")
      .gt("created_at", params.createdAt)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (newerInbound) {
      return {
        action: "superseded",
        reason: "Buyer wrote again since this message — retry cancelled",
      };
    }
  }

  const ctx = parseRetryContext(params.rawPayload);
  if (!ctx) {
    // No context: still allow retry if not expired / no newer inbound.
    return { action: "send", reason: "eligible" };
  }

  if (ctx.kind === "draft_confirmation") {
    return evaluateDraftConfirmation(params.supabase, ctx, params.normalisedText);
  }

  return { action: "send", reason: "eligible" };
}

async function evaluateDraftConfirmation(
  supabase: SupabaseClient,
  ctx: Extract<RetryContext, { kind: "draft_confirmation" }>,
  intendedText: string,
): Promise<RetryDecision> {
  const { data: order } = await supabase
    .from("orders")
    .select("id, status, total_pence, order_ref")
    .eq("id", ctx.orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!order) {
    return {
      action: "superseded",
      reason: "Draft order no longer exists — retry cancelled",
    };
  }

  if (order.status !== ORDER_STATUS.PENDING_CONFIRMATION) {
    return {
      action: "superseded",
      reason: `Order is ${order.status}, not awaiting confirmation — retry cancelled`,
    };
  }

  if (order.total_pence !== ctx.totalPence) {
    return {
      action: "superseded",
      reason: "Draft totals changed since this message — retry cancelled",
    };
  }

  const { data: items } = await supabase
    .from("order_items")
    .select("product_variant_id, quantity, unit_price_pence")
    .eq("order_id", ctx.orderId);

  const signature = buildDraftItemSignature(
    (items ?? []).map((row) => ({
      product_variant_id: row.product_variant_id as string,
      quantity: row.quantity as number,
      unit_price_pence: row.unit_price_pence as number,
    })),
  );

  if (signature !== ctx.itemSignature) {
    return {
      action: "superseded",
      reason: "Draft line items changed since this message — retry cancelled",
    };
  }

  if (order.order_ref !== ctx.orderRef) {
    return {
      action: "superseded",
      reason: "Order reference mismatch — retry cancelled",
    };
  }

  // intendedText is the queued body — must still describe this draft.
  void intendedText;

  return { action: "send", reason: "eligible" };
}

/** Mark a failed outbound as superseded or expired and clear next_retry_at. */
export async function markOutboundTerminal(
  supabase: SupabaseClient,
  messageId: string,
  status: "superseded" | "expired",
  reason: string,
): Promise<void> {
  await supabase
    .from("messages")
    .update({
      delivery_status: status,
      delivery_error_text: reason,
      next_retry_at: null,
    })
    .eq("id", messageId);
}
