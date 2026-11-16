import { NextResponse } from "next/server";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { isInServiceWindow } from "@/lib/channels/service-window";
import { getCustomerPreferredLanguage } from "@/lib/i18n/language";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const PREFILL = {
  en: (orderRef: string) =>
    `I'm sorry about the problem with order ${orderRef}. I can offer a refund or a replacement once the dispute with your bank is withdrawn. If you are happy with that, please ask your bank to withdraw the dispute, and I will sort this out afterwards.`,
  fr: (orderRef: string) =>
    `Je suis désolé(e) pour le problème concernant la commande ${orderRef}. Je peux proposer un remboursement ou un remplacement une fois le litige retiré auprès de votre banque. Si cela vous convient, demandez à votre banque de retirer le litige, puis je réglerai la suite.`,
} as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ disputeId: string }> },
) {
  const { disputeId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    text?: string;
    mode?: "send" | "copied";
  };
  const mode = body.mode === "copied" ? "copied" : "send";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dispute } = await supabase
    .from("disputes")
    .select("id, business_id, order_id, closed_at")
    .eq("id", disputeId)
    .maybeSingle();
  if (!dispute) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: owned } = await supabase
    .from("businesses")
    .select("id")
    .eq("id", dispute.business_id)
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!owned) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!dispute.order_id) {
    return NextResponse.json(
      { error: "No order linked to this dispute" },
      { status: 400 },
    );
  }

  const { data: order } = await supabase
    .from("orders")
    .select(
      "id, order_ref, customer_id, thread_id, customers(phone_e164, last_customer_message_at)",
    )
    .eq("id", dispute.order_id)
    .eq("business_id", dispute.business_id)
    .maybeSingle();
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const customers = order.customers as
    | { phone_e164: string; last_customer_message_at: string | null }
    | { phone_e164: string; last_customer_message_at: string | null }[]
    | null;
  const customer = Array.isArray(customers) ? customers[0] : customers;
  const phone = customer?.phone_e164;
  if (!phone) {
    return NextResponse.json({ error: "Buyer phone missing" }, { status: 400 });
  }

  const admin = createAdminClient();
  const lang = order.customer_id
    ? await getCustomerPreferredLanguage(admin, order.customer_id as string)
    : "en";
  const replyLang = lang === "fr" ? "fr" : "en";
  const orderRef = (order.order_ref as string) ?? "your order";
  const defaultText = PREFILL[replyLang](orderRef);
  const text = (body.text?.trim() || defaultText).slice(0, 4000);

  const inWindow = isInServiceWindow({
    last_customer_message_at: customer?.last_customer_message_at ?? null,
  });

  const now = new Date().toISOString();

  if (mode === "copied" || !inWindow) {
    await admin
      .from("disputes")
      .update({
        cheaper_resolution_copied_at: now,
        updated_at: now,
      })
      .eq("id", disputeId);
    return NextResponse.json({
      ok: true,
      mode: "copied",
      inWindow,
      text,
      note: inWindow
        ? null
        : "The buyer is outside WhatsApp's 24-hour window. Copy this and contact them another way.",
    });
  }

  try {
    await sendWhatsAppMessage({
      businessId: dispute.business_id as string,
      toPhoneE164: phone,
      text,
      supabase: admin,
      audience: "buyer",
      customerId: (order.customer_id as string) ?? undefined,
      threadId: (order.thread_id as string | null) ?? undefined,
    });
    await admin
      .from("disputes")
      .update({
        cheaper_resolution_sent_at: now,
        updated_at: now,
      })
      .eq("id", disputeId);
    return NextResponse.json({ ok: true, mode: "sent", inWindow: true, text });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export function cheaperResolutionPrefill(orderRef: string, lang: "en" | "fr") {
  return PREFILL[lang](orderRef);
}
