import type { SupabaseClient } from "@supabase/supabase-js";

import { generateSupportReply } from "@/lib/ai/tasks/support-reply";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifySellerOfQuestion } from "@/lib/support/notify-seller";

export const OTHER_FALLBACK_MESSAGE =
  "Sorry, I didn't quite catch that — did you want to place an order, or is there something else I can help with?";

export interface SupportSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface SupportInboundOutcome {
  action: "answered" | "escalated" | "fallback" | "error";
  intent: "question" | "other";
  reply: string;
  escalateToSeller: boolean;
  aiCalled: boolean;
  buyerSend: SupportSendResult;
  sellerNotify?: {
    attempted: boolean;
    ok: boolean;
    messageId?: string;
    error?: string;
    text?: string;
  };
  error?: string;
}

export interface HandleSupportParams {
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string;
  messageText: string;
  supabase?: SupabaseClient;
}

/**
 * intent: "question" — generate a context-grounded reply and send it.
 * Escalations also WhatsApp the seller with the buyer's original question.
 */
export async function handleQuestionReply(
  params: HandleSupportParams,
): Promise<SupportInboundOutcome> {
  const supabase = params.supabase ?? createAdminClient();

  let generated;
  try {
    generated = await generateSupportReply({
      businessId: params.businessId,
      messageText: params.messageText,
      threadId: params.threadId,
      supabase,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[support] support_reply failed", {
      businessId: params.businessId,
      threadId: params.threadId,
      error: message,
    });
    return {
      action: "error",
      intent: "question",
      reply: "",
      escalateToSeller: false,
      aiCalled: true,
      buyerSend: { ok: false, error: "ai_failed" },
      error: message,
    };
  }

  const buyerSend = await trySend({
    businessId: params.businessId,
    toPhoneE164: params.customerPhoneE164,
    text: generated.reply,
    threadId: params.threadId,
    customerId: params.customerId,
    supabase,
    label: "buyer support reply",
  });

  let sellerNotify: SupportInboundOutcome["sellerNotify"];
  if (generated.escalate_to_seller) {
    sellerNotify = await notifySellerOfQuestion({
      businessId: params.businessId,
      customerPhoneE164: params.customerPhoneE164,
      question: params.messageText,
      supabase,
    });
  }

  return {
    action: generated.escalate_to_seller ? "escalated" : "answered",
    intent: "question",
    reply: generated.reply,
    escalateToSeller: generated.escalate_to_seller,
    aiCalled: true,
    buyerSend,
    ...(sellerNotify ? { sellerNotify } : {}),
  };
}

/**
 * intent: "other" — fixed fallback, no AI call.
 */
export async function handleOtherFallback(
  params: HandleSupportParams,
): Promise<SupportInboundOutcome> {
  const supabase = params.supabase ?? createAdminClient();
  const buyerSend = await trySend({
    businessId: params.businessId,
    toPhoneE164: params.customerPhoneE164,
    text: OTHER_FALLBACK_MESSAGE,
    threadId: params.threadId,
    customerId: params.customerId,
    supabase,
    label: "other fallback",
  });

  return {
    action: "fallback",
    intent: "other",
    reply: OTHER_FALLBACK_MESSAGE,
    escalateToSeller: false,
    aiCalled: false,
    buyerSend,
  };
}

async function trySend(params: {
  businessId: string;
  toPhoneE164: string;
  text: string;
  threadId?: string;
  customerId?: string;
  supabase: SupabaseClient;
  label: string;
}): Promise<SupportSendResult> {
  try {
    const sent = await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: params.toPhoneE164,
      text: params.text,
      threadId: params.threadId,
      customerId: params.customerId,
      supabase: params.supabase,
    });
    return { ok: true, messageId: sent.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[support] ${params.label} send failed`, {
      businessId: params.businessId,
      to: params.toPhoneE164,
      error: message,
    });
    return { ok: false, error: message };
  }
}
