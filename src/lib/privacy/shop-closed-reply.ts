import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { t, type SupportedLang } from "@/lib/i18n";
import { SHOP_CLOSED_REPLY_COOLDOWN_MS } from "@/lib/privacy/constants";

/**
 * Send "This shop has closed" at most once per buyer per 10 minutes.
 * No AI, no order handling — fixed EN/FR copy only.
 */
export async function maybeSendShopClosedReply(params: {
  supabase: SupabaseClient;
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string;
  lang: SupportedLang;
}): Promise<{ sent: boolean; skipped: boolean; messageId: string | null }> {
  const recent = await findRecentShopClosedReply(
    params.supabase,
    params.customerId,
  );
  if (recent) {
    return { sent: false, skipped: true, messageId: recent };
  }

  const text = t("billing.shop_closed", params.lang);
  const sent = await sendWhatsAppMessage({
    businessId: params.businessId,
    toPhoneE164: params.customerPhoneE164,
    text,
    threadId: params.threadId,
    customerId: params.customerId,
    supabase: params.supabase,
    audience: "buyer",
    retryContext: { kind: "generic" },
  });

  if (sent.messageId) {
    const { data: existing } = await params.supabase
      .from("messages")
      .select("raw_payload")
      .eq("id", sent.messageId)
      .maybeSingle();
    const prior =
      existing?.raw_payload && typeof existing.raw_payload === "object"
        ? (existing.raw_payload as Record<string, unknown>)
        : {};
    await params.supabase
      .from("messages")
      .update({
        raw_payload: {
          ...prior,
          kind: "shop_closed",
        },
      })
      .eq("id", sent.messageId);
  }

  return {
    sent: true,
    skipped: false,
    messageId: sent.messageId || null,
  };
}

async function findRecentShopClosedReply(
  supabase: SupabaseClient,
  customerId: string,
): Promise<string | null> {
  const since = new Date(
    Date.now() - SHOP_CLOSED_REPLY_COOLDOWN_MS,
  ).toISOString();
  const { data } = await supabase
    .from("messages")
    .select("id, raw_payload, normalised_text")
    .eq("customer_id", customerId)
    .eq("direction", "outbound")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  for (const row of data ?? []) {
    const raw = (row.raw_payload ?? {}) as Record<string, unknown>;
    if (raw.kind === "shop_closed") return row.id as string;
    const text = (row.normalised_text as string | null) ?? "";
    if (
      /^this shop has closed\.?$/i.test(text.trim()) ||
      /^cette boutique a fermé\.?$/i.test(text.trim())
    ) {
      return row.id as string;
    }
  }
  return null;
}
