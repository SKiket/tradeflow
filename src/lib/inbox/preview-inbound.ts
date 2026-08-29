import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseOrder, type OrderParseResult } from "@/lib/ai/tasks/order-parse";
import { generateSupportReply } from "@/lib/ai/tasks/support-reply";
import { previewDraftBuyerReply } from "@/lib/orders/create-draft-order";
import { OTHER_FALLBACK_MESSAGE } from "@/lib/support/handle-inbound";

export type InboxPreviewResult = {
  sandbox: true;
  intent: OrderParseResult["intent"];
  confidence: number;
  needsClarification: boolean;
  clarificationMessage: string | null;
  escalateToSeller: boolean;
  matchedItems: OrderParseResult["items"];
  reply: string;
  orderPath:
    | "ignored"
    | "clarification"
    | "stock_shortage"
    | "draft_confirmation"
    | null;
};

/**
 * Run the live order_parse → draft/support/fallback pipeline against the
 * seller's current catalog, without persisting messages, creating orders,
 * or sending WhatsApp.
 */
export async function previewInboundMessage(params: {
  businessId: string;
  messageText: string;
  supabase: SupabaseClient;
}): Promise<InboxPreviewResult> {
  const text = params.messageText.trim();
  if (!text) {
    throw new Error("Enter a sample buyer message.");
  }

  const sandboxThreadId = randomUUID();
  const parse = await parseOrder({
    businessId: params.businessId,
    messageText: text,
    threadId: sandboxThreadId,
    supabase: params.supabase,
  });

  if (parse.intent === "order") {
    const draft = await previewDraftBuyerReply(
      params.supabase,
      params.businessId,
      parse,
    );
    const reply =
      draft.reply ??
      parse.clarification_message?.trim() ??
      "No buyer WhatsApp would be sent for this order parse.";
    return {
      sandbox: true,
      intent: parse.intent,
      confidence: parse.confidence,
      needsClarification: parse.needs_clarification,
      clarificationMessage: parse.clarification_message,
      escalateToSeller: parse.needs_clarification,
      matchedItems: parse.items,
      reply,
      orderPath: draft.action,
    };
  }

  if (parse.intent === "question") {
    const support = await generateSupportReply({
      businessId: params.businessId,
      messageText: text,
      threadId: sandboxThreadId,
      supabase: params.supabase,
    });
    return {
      sandbox: true,
      intent: parse.intent,
      confidence: parse.confidence,
      needsClarification: parse.needs_clarification,
      clarificationMessage: parse.clarification_message,
      escalateToSeller: support.escalate_to_seller,
      matchedItems: parse.items,
      reply: support.reply,
      orderPath: null,
    };
  }

  return {
    sandbox: true,
    intent: "other",
    confidence: parse.confidence,
    needsClarification: parse.needs_clarification,
    clarificationMessage: parse.clarification_message,
    escalateToSeller: false,
    matchedItems: parse.items,
    reply: OTHER_FALLBACK_MESSAGE,
    orderPath: null,
  };
}
