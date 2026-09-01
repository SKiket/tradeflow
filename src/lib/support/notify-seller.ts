import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";

export interface SellerNotifyResult {
  attempted: boolean;
  ok: boolean;
  messageId?: string;
  error?: string;
  text?: string;
}

/**
 * WhatsApp the seller about a support question the assistant could not answer.
 */
export async function notifySellerOfQuestion(params: {
  businessId: string;
  customerPhoneE164: string;
  question: string;
  supabase: SupabaseClient;
}): Promise<SellerNotifyResult> {
  const quoted = params.question.trim();
  const text = [
    "A buyer asked a question your shop assistant couldn't answer from your settings:",
    "",
    `"${quoted}"`,
    "",
    `Buyer WhatsApp: ${params.customerPhoneE164}`,
    "",
    "Please reply to them directly.",
  ].join("\n");

  return notifySeller({
    businessId: params.businessId,
    text,
    supabase: params.supabase,
    label: "seller question escalate",
  });
}

/**
 * WhatsApp the seller when order_parse could not confidently match an order.
 * Buyer-facing clarification is unchanged — this is seller visibility only.
 */
export async function notifySellerOfUnmatchedOrder(params: {
  businessId: string;
  customerPhoneE164: string;
  buyerMessage: string;
  supabase: SupabaseClient;
}): Promise<SellerNotifyResult> {
  const quoted = params.buyerMessage.trim();
  const text = [
    "A buyer tried to order something we couldn't match:",
    "",
    `"${quoted}"`,
    "",
    `Buyer WhatsApp: ${params.customerPhoneE164}`,
    "",
    "Please reply to them directly.",
  ].join("\n");

  return notifySeller({
    businessId: params.businessId,
    text,
    supabase: params.supabase,
    label: "seller unmatched order",
  });
}

/**
 * WhatsApp the seller when a buyer requests a return.
 */
export async function notifySellerOfReturnRequest(params: {
  businessId: string;
  orderRef: string;
  reasonLabel: string;
  detail?: string | null;
  supabase: SupabaseClient;
}): Promise<SellerNotifyResult> {
  const lines = [
    `Return requested for ${params.orderRef}`,
    `Reason: ${params.reasonLabel}`,
  ];
  if (params.detail?.trim()) {
    lines.push(`Details: ${params.detail.trim()}`);
  }
  lines.push("", "Review it in your dashboard to approve or decline.");
  return notifySeller({
    businessId: params.businessId,
    text: lines.join("\n"),
    supabase: params.supabase,
    label: "seller return request",
  });
}

async function notifySeller(params: {
  businessId: string;
  text: string;
  supabase: SupabaseClient;
  label: string;
}): Promise<SellerNotifyResult> {
  const { data: business, error } = await params.supabase
    .from("businesses")
    .select("seller_whatsapp_phone_e164")
    .eq("id", params.businessId)
    .maybeSingle();

  if (error) {
    console.error(`[support] ${params.label} phone lookup failed`, {
      businessId: params.businessId,
      error: error.message,
    });
    return { attempted: true, ok: false, error: error.message, text: params.text };
  }

  const sellerPhone = business?.seller_whatsapp_phone_e164?.trim();
  if (!sellerPhone) {
    console.warn(`[support] ${params.label} skipped — no seller_whatsapp_phone_e164`, {
      businessId: params.businessId,
    });
    return {
      attempted: false,
      ok: false,
      error: "no_seller_whatsapp_phone_e164",
      text: params.text,
    };
  }

  try {
    const sent = await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: sellerPhone,
      text: params.text,
      supabase: params.supabase,
    });
    return {
      attempted: true,
      ok: true,
      messageId: sent.messageId,
      text: params.text,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[support] ${params.label} send failed`, {
      businessId: params.businessId,
      to: sellerPhone,
      error: message,
    });
    return {
      attempted: true,
      ok: false,
      error: message,
      text: params.text,
    };
  }
}
