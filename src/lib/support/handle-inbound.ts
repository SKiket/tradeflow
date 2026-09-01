import type { SupabaseClient } from "@supabase/supabase-js";

import { generateSupportReply } from "@/lib/ai/tasks/support-reply";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import {
  buyerReturnAlreadyMessage,
  buyerReturnApprovedMessage,
  buyerReturnNotDeliveredMessage,
  buyerReturnRequestedMessage,
  buyerReturnWhichOrderMessage,
  findCustomerOrderByRef,
  listCustomerDeliveredOrders,
  requestReturn,
  type RequestReturnOutcome,
} from "@/lib/orders/request-return";
import { parseReturnReason } from "@/lib/orders/return-reasons";
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
  returnOutcome?: RequestReturnOutcome | { action: "needs_clarification" };
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
 * Return requests call requestReturn() and send a deterministic confirmation.
 * Other escalations also WhatsApp the seller with the buyer's original question.
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
      customerId: params.customerId,
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

  let reply = generated.reply;
  let escalateToSeller = generated.escalate_to_seller;
  let returnOutcome: SupportInboundOutcome["returnOutcome"];
  let skipBuyerSend = false;

  if (generated.is_return_request) {
    escalateToSeller = false;
    const applied = await applyReturnRequest({
      supabase,
      businessId: params.businessId,
      customerId: params.customerId,
      messageText: params.messageText,
      returnOrderRef: generated.return_order_ref,
      returnReason: generated.return_reason,
      returnReasonDetail: generated.return_reason_detail,
    });
    reply = applied.reply;
    returnOutcome = applied.returnOutcome;
    skipBuyerSend = applied.returnOutcome?.action === "auto_approved";
  }

  const buyerSend = skipBuyerSend
    ? { ok: true }
    : await trySend({
    businessId: params.businessId,
    toPhoneE164: params.customerPhoneE164,
    text: reply,
    threadId: params.threadId,
    customerId: params.customerId,
    supabase,
    label: "buyer support reply",
  });

  let sellerNotify: SupportInboundOutcome["sellerNotify"];
  if (escalateToSeller) {
    sellerNotify = await notifySellerOfQuestion({
      businessId: params.businessId,
      customerPhoneE164: params.customerPhoneE164,
      question: params.messageText,
      supabase,
    });
  }

  return {
    action: escalateToSeller ? "escalated" : "answered",
    intent: "question",
    reply,
    escalateToSeller,
    aiCalled: true,
    buyerSend,
    ...(sellerNotify ? { sellerNotify } : {}),
    ...(returnOutcome ? { returnOutcome } : {}),
  };
}

async function applyReturnRequest(params: {
  supabase: SupabaseClient;
  businessId: string;
  customerId: string;
  messageText: string;
  returnOrderRef: string | null;
  returnReason: string | null;
  returnReasonDetail: string | null;
}): Promise<{
  reply: string;
  returnOutcome: SupportInboundOutcome["returnOutcome"];
}> {
  const delivered = await listCustomerDeliveredOrders(params.supabase, {
    businessId: params.businessId,
    customerId: params.customerId,
  });

  const messageUpper = params.messageText.toUpperCase();
  const mentioned = delivered.filter((order) =>
    messageUpper.includes(order.orderRef.toUpperCase()),
  );

  if (delivered.length > 1 && mentioned.length !== 1) {
    return {
      reply: buyerReturnWhichOrderMessage(delivered.map((order) => order.orderRef)),
      returnOutcome: { action: "needs_clarification" },
    };
  }

  let target: { id: string; orderRef: string; status: string } | null = null;
  if (mentioned.length === 1) {
    target = mentioned[0];
  } else if (params.returnOrderRef) {
    target = await findCustomerOrderByRef(params.supabase, {
      businessId: params.businessId,
      customerId: params.customerId,
      orderRef: params.returnOrderRef,
    });
  } else if (delivered.length === 1) {
    target = delivered[0];
  }

  if (!target) {
    return {
      reply: buyerReturnNotDeliveredMessage({}),
      returnOutcome: { action: "not_found" },
    };
  }

  const reason = parseReturnReason(params.returnReason) ?? "other";
  const detail =
    params.returnReasonDetail?.trim() ||
    (reason === "other" ? params.messageText.trim() : null);

  const outcome = await requestReturn(
    params.supabase,
    target.id,
    reason,
    detail,
  );

  if (outcome.action === "requested") {
    return {
      reply: buyerReturnRequestedMessage({
        orderRef: outcome.orderRef,
        reason: outcome.reason,
        detail: outcome.detail,
      }),
      returnOutcome: outcome,
    };
  }
  if (outcome.action === "auto_approved") {
    return {
      reply: buyerReturnApprovedMessage(outcome.orderRef),
      returnOutcome: outcome,
    };
  }
  if (outcome.action === "not_delivered") {
    return {
      reply: buyerReturnNotDeliveredMessage({
        orderRef: outcome.orderRef,
        status: outcome.status,
      }),
      returnOutcome: outcome,
    };
  }
  if (outcome.action === "already_requested") {
    return {
      reply: buyerReturnAlreadyMessage({
        orderRef: outcome.orderRef,
        status: outcome.status,
      }),
      returnOutcome: outcome,
    };
  }

  return {
    reply: buyerReturnNotDeliveredMessage({
      orderRef: target.orderRef,
      status: target.status,
    }),
    returnOutcome: outcome,
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
