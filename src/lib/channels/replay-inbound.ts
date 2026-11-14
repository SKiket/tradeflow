import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseOrder,
  type OrderParseResult,
} from "@/lib/ai/tasks/order-parse";
import {
  enqueuePendingReplay,
  isRateLimitErrorMessage,
  nextReplayAttemptAt,
} from "@/lib/channels/pending-replay";
import { createDraftOrderFromParse } from "@/lib/orders/create-draft-order";
import {
  handleOtherFallback,
  handleQuestionReply,
} from "@/lib/support/handle-inbound";
import {
  getCustomerPreferredLanguage,
  maybeUpdatePreferredLanguage,
} from "@/lib/i18n/language";

function coerceStoredParse(raw: unknown): OrderParseResult | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (row.intent !== "order" && row.intent !== "question" && row.intent !== "other") {
    return null;
  }
  if (!Array.isArray(row.items) && row.intent === "order") return null;
  return {
    intent: row.intent,
    confidence: typeof row.confidence === "number" ? row.confidence : 0,
    language: typeof row.language === "string" ? row.language : "en",
    needs_clarification: row.needs_clarification === true,
    clarification_message:
      typeof row.clarification_message === "string"
        ? row.clarification_message
        : null,
    items: Array.isArray(row.items)
      ? (row.items as OrderParseResult["items"])
      : [],
  };
}

export interface ReplayInboundResult {
  action:
    | "draft_ok"
    | "draft_send_failed"
    | "support_ok"
    | "support_failed"
    | "ignored"
    | "error";
  detail: string;
  buyerReplyDelivered: boolean;
}

/**
 * Re-run the normal inbound pipeline for an already-persisted inbound
 * message. Idempotent for drafts: createDraftOrderFromParse updates the
 * existing PENDING_CONFIRMATION in place (keyed by thread), never creates
 * a second draft for the same correction.
 */
export async function replayInboundMessage(params: {
  supabase: SupabaseClient;
  inboundMessageId: string;
}): Promise<ReplayInboundResult> {
  const { data: msg, error } = await params.supabase
    .from("messages")
    .select(
      "id, business_id, customer_id, thread_id, normalised_text, direction, ai_parse_result, source_kind",
    )
    .eq("id", params.inboundMessageId)
    .maybeSingle();

  if (error || !msg) {
    return {
      action: "error",
      detail: error?.message ?? "inbound message not found",
      buyerReplyDelivered: false,
    };
  }
  if (msg.direction !== "inbound") {
    return {
      action: "error",
      detail: "not an inbound message",
      buyerReplyDelivered: false,
    };
  }

  const { data: customer } = await params.supabase
    .from("customers")
    .select("phone_e164")
    .eq("id", msg.customer_id)
    .maybeSingle();
  const phone = customer?.phone_e164 as string | undefined;
  if (!phone) {
    return {
      action: "error",
      detail: "customer phone missing",
      buyerReplyDelivered: false,
    };
  }

  const messageText = ((msg.normalised_text as string | null) ?? "").trim();
  if (!messageText) {
    return {
      action: "ignored",
      detail: "empty text",
      buyerReplyDelivered: false,
    };
  }

  const preferredLanguage = await getCustomerPreferredLanguage(
    params.supabase,
    msg.customer_id as string,
  );

  // Prefer the stored parse when present so replay is idempotent and does
  // not depend on a fresh AI call returning the same structure.
  let parseResult = coerceStoredParse(msg.ai_parse_result);
  if (!parseResult) {
    parseResult = await parseOrder({
      businessId: msg.business_id as string,
      messageText,
      threadId: msg.thread_id as string,
      preferredLanguage,
      supabase: params.supabase,
    });
    await maybeUpdatePreferredLanguage({
      supabase: params.supabase,
      customerId: msg.customer_id as string,
      messageText,
      detectedLanguage: parseResult.language,
    });
    await params.supabase
      .from("messages")
      .update({ ai_parse_result: parseResult })
      .eq("id", msg.id);
  }

  if (parseResult.intent === "order") {
    const outcome = await createDraftOrderFromParse({
      businessId: msg.business_id as string,
      customerId: msg.customer_id as string,
      customerPhoneE164: phone,
      threadId: msg.thread_id as string,
      parseResult,
      supabase: params.supabase,
      inboundMessageId: msg.id as string,
      // Replay must not re-enqueue on failure — caller manages the queue row.
      skipReplayEnqueue: true,
    });

    if (outcome.action === "ignored") {
      return {
        action: "ignored",
        detail: outcome.reason,
        buyerReplyDelivered: false,
      };
    }

    if (
      outcome.action === "draft_created" ||
      outcome.action === "draft_updated"
    ) {
      if (outcome.sendError) {
        return {
          action: "draft_send_failed",
          detail: outcome.sendError,
          buyerReplyDelivered: false,
        };
      }
      return {
        action: "draft_ok",
        detail: `${outcome.action}:${outcome.orderRef}`,
        buyerReplyDelivered: true,
      };
    }

    // clarification / stock — check outboundMessageId
    if (
      outcome.action === "clarification_sent" ||
      outcome.action === "stock_shortage"
    ) {
      const delivered = Boolean(outcome.outboundMessageId);
      return {
        action: delivered ? "draft_ok" : "draft_send_failed",
        detail: outcome.action,
        buyerReplyDelivered: delivered,
      };
    }
  }

  if (parseResult.intent === "question") {
    const outcome = await handleQuestionReply({
      businessId: msg.business_id as string,
      customerId: msg.customer_id as string,
      customerPhoneE164: phone,
      threadId: msg.thread_id as string,
      messageText,
      supabase: params.supabase,
    });
    const ok = outcome.buyerSend?.ok === true;
    return {
      action: ok ? "support_ok" : "support_failed",
      detail: outcome.buyerSend?.error ?? outcome.action,
      buyerReplyDelivered: ok,
    };
  }

  const outcome = await handleOtherFallback({
    businessId: msg.business_id as string,
    customerId: msg.customer_id as string,
    customerPhoneE164: phone,
    threadId: msg.thread_id as string,
    messageText,
    supabase: params.supabase,
  });
  const ok = outcome.buyerSend?.ok === true;
  return {
    action: ok ? "support_ok" : "support_failed",
    detail: outcome.buyerSend?.error ?? outcome.action,
    buyerReplyDelivered: ok,
  };
}

export function scheduleAfterFailedReplay(params: {
  attempts: number;
  lastError: string;
}): { nextAttemptAt: string | null; terminalFailed: boolean } {
  const next = nextReplayAttemptAt(params.attempts);
  if (!next) {
    return { nextAttemptAt: null, terminalFailed: true };
  }
  // Rate-limit errors use the same backoff schedule.
  void isRateLimitErrorMessage(params.lastError);
  return { nextAttemptAt: next, terminalFailed: false };
}

export { enqueuePendingReplay };
