import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseRetryContext,
  RETRY_MAX_AGE_MS,
} from "@/lib/channels/send/delivery";

export type RetryDecision =
  | { action: "send"; reason: "eligible" }
  | { action: "expired"; reason: string }
  | { action: "superseded"; reason: string };

/**
 * Plain-text outbound retries only (dispatch / delivery / refund / reminders).
 * State-dependent replies (draft confirmation, payment link) are superseded
 * here — recovery is via pending_replay of the inbound message.
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
    return { action: "send", reason: "eligible" };
  }

  if (ctx.kind === "draft_confirmation" || ctx.kind === "payment_link") {
    return {
      action: "superseded",
      reason:
        "State-dependent reply — recovered via inbound replay, not text retry",
    };
  }

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
