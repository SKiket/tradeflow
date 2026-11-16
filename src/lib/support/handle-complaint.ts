import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { getCustomerPreferredLanguage } from "@/lib/i18n/language";
import {
  COMPLAINT_BUYER_REPLY,
  detectPaymentComplaint,
} from "@/lib/support/complaint-phrases";
import { notifySellerOfComplaint } from "@/lib/support/notify-seller";

export type ComplaintHandleResult =
  | { matched: false }
  | {
      matched: true;
      orderId: string | null;
      orderRef: string | null;
      buyerReplied: boolean;
      sellerNotified: boolean;
    };

/**
 * Deterministic payment-complaint check. On match: mark conversation + latest
 * order urgent, alert seller (seller_needs_attention), send fixed EN/FR reply,
 * skip AI. False positives are harmless.
 */
export async function maybeHandlePaymentComplaint(params: {
  supabase: SupabaseClient;
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string | null;
  messageText: string;
}): Promise<ComplaintHandleResult> {
  if (!detectPaymentComplaint(params.messageText)) {
    return { matched: false };
  }

  const now = new Date().toISOString();

  await params.supabase
    .from("customers")
    .update({
      seller_attention_urgent_at: now,
      updated_at: now,
    })
    .eq("id", params.customerId)
    .eq("business_id", params.businessId);

  const { data: latestOrder } = await params.supabase
    .from("orders")
    .select("id, order_ref")
    .eq("business_id", params.businessId)
    .eq("customer_id", params.customerId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let orderId: string | null = null;
  let orderRef: string | null = null;
  if (latestOrder) {
    orderId = latestOrder.id as string;
    orderRef = latestOrder.order_ref as string;
    await params.supabase
      .from("orders")
      .update({
        seller_attention_urgent_at: now,
        updated_at: now,
      })
      .eq("id", orderId)
      .eq("business_id", params.businessId);
  }

  const lang = await getCustomerPreferredLanguage(
    params.supabase,
    params.customerId,
  );
  const replyLang = lang === "fr" ? "fr" : "en";
  const replyText = COMPLAINT_BUYER_REPLY[replyLang];

  let buyerReplied = false;
  try {
    await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: params.customerPhoneE164,
      text: replyText,
      supabase: params.supabase,
      audience: "buyer",
      customerId: params.customerId,
      threadId: params.threadId ?? undefined,
    });
    buyerReplied = true;
  } catch (caught) {
    console.error("[complaint] buyer reply failed", {
      customerId: params.customerId,
      error: caught instanceof Error ? caught.message : String(caught),
    });
  }

  const seller = await notifySellerOfComplaint({
    businessId: params.businessId,
    customerPhoneE164: params.customerPhoneE164,
    orderRef: orderRef ?? "conversation",
    supabase: params.supabase,
  });

  return {
    matched: true,
    orderId,
    orderRef,
    buyerReplied,
    sellerNotified: seller.ok,
  };
}
