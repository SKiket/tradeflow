import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { getBusinessSellerLanguage } from "@/lib/channels/templates/business-language";
import type { TemplateKey } from "@/lib/channels/templates/registry";

export type DisputeNotifyResult = {
  attempted: boolean;
  ok: boolean;
  error?: string;
};

function formatDeadline(iso: string | null | undefined): string {
  if (!iso) return "the evidence deadline";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "Europe/London",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

async function sendSellerDisputeMessage(params: {
  supabase: SupabaseClient;
  businessId: string;
  text: string;
  template: { key: TemplateKey; variables: Record<string, string> };
  label: string;
}): Promise<DisputeNotifyResult> {
  const { data: business, error } = await params.supabase
    .from("businesses")
    .select("seller_whatsapp_phone_e164")
    .eq("id", params.businessId)
    .maybeSingle();

  if (error) {
    console.error(`[disputes] ${params.label} phone lookup failed`, {
      businessId: params.businessId,
      error: error.message,
    });
    return { attempted: true, ok: false, error: error.message };
  }

  const sellerPhone = business?.seller_whatsapp_phone_e164?.trim();
  if (!sellerPhone) {
    console.warn(`[disputes] ${params.label} skipped — no seller phone`, {
      businessId: params.businessId,
    });
    return { attempted: false, ok: false, error: "no_seller_whatsapp_phone_e164" };
  }

  try {
    const sellerLang = await getBusinessSellerLanguage(
      params.supabase,
      params.businessId,
    );
    await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: sellerPhone,
      text: params.text,
      supabase: params.supabase,
      audience: "seller",
      templateLanguage: sellerLang,
      template: params.template,
    });
    return { attempted: true, ok: true };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(`[disputes] ${params.label} send failed`, {
      businessId: params.businessId,
      error: message,
    });
    return { attempted: true, ok: false, error: message };
  }
}

export async function notifySellerDisputeOpened(params: {
  supabase: SupabaseClient;
  businessId: string;
  orderRef: string;
  evidenceDueBy: string | null;
}): Promise<DisputeNotifyResult> {
  const deadline = formatDeadline(params.evidenceDueBy);
  const text = `A customer has disputed the payment for order ${params.orderRef}. The response deadline is ${deadline}. Open your TradeFlow dashboard to review and add details.`;
  return sendSellerDisputeMessage({
    supabase: params.supabase,
    businessId: params.businessId,
    text,
    label: "dispute opened",
    template: {
      key: "seller_dispute_opened",
      variables: { orderRef: params.orderRef, deadlineDate: deadline },
    },
  });
}

export async function notifySellerDisputeClosed(params: {
  supabase: SupabaseClient;
  businessId: string;
  orderRef: string;
  outcome: "won" | "lost";
}): Promise<DisputeNotifyResult> {
  const text = `The payment dispute for order ${params.orderRef} has closed: you ${params.outcome}. Open your TradeFlow dashboard for details.`;
  return sendSellerDisputeMessage({
    supabase: params.supabase,
    businessId: params.businessId,
    text,
    label: "dispute closed",
    template: {
      key: "seller_dispute_closed",
      variables: { orderRef: params.orderRef, outcome: params.outcome },
    },
  });
}

export async function notifySellerDisputeReminder(params: {
  supabase: SupabaseClient;
  businessId: string;
  orderRef: string;
  evidenceDueBy: string | null;
}): Promise<DisputeNotifyResult> {
  const deadline = formatDeadline(params.evidenceDueBy);
  const text = `Reminder: your response to the payment dispute for order ${params.orderRef} is due by ${deadline}. Open your TradeFlow dashboard to confirm your evidence.`;
  return sendSellerDisputeMessage({
    supabase: params.supabase,
    businessId: params.businessId,
    text,
    label: "dispute reminder",
    template: {
      key: "seller_dispute_reminder",
      variables: { orderRef: params.orderRef, deadlineDate: deadline },
    },
  });
}

export async function notifySellerDisputeAutoSubmitted(params: {
  supabase: SupabaseClient;
  businessId: string;
  orderRef: string;
}): Promise<DisputeNotifyResult> {
  const text = `We submitted the evidence pack for the payment dispute on order ${params.orderRef} because the deadline was approaching. Open your TradeFlow dashboard for details.`;
  return sendSellerDisputeMessage({
    supabase: params.supabase,
    businessId: params.businessId,
    text,
    label: "dispute auto-submit",
    template: {
      key: "seller_dispute_reminder",
      variables: {
        orderRef: params.orderRef,
        deadlineDate: "submitted automatically",
      },
    },
  });
}
