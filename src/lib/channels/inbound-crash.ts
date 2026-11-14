import type { SupabaseClient } from "@supabase/supabase-js";

import { APOLOGY_COOLDOWN_MS } from "@/lib/channels/send/delivery";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { t } from "@/lib/i18n";
import { getCustomerPreferredLanguage } from "@/lib/i18n/language";

export interface InboundCrashParams {
  supabase: SupabaseClient;
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string;
  inboundMessageId: string | null;
  error: unknown;
}

export interface InboundCrashResult {
  recorded: boolean;
  processingMessageId: string | null;
  apologySent: boolean;
  apologySkipped: boolean;
  apologyMessageId: string | null;
  apologyError: string | null;
  errorText: string;
}

/**
 * Catch-all after inbound persist: record failed-processing, send at most
 * one localized apology per buyer per 10 minutes, surface on seller banner.
 */
export async function handleInboundProcessingFailure(
  params: InboundCrashParams,
): Promise<InboundCrashResult> {
  const errorText =
    params.error instanceof Error ? params.error.message : String(params.error);
  const shortError =
    errorText.length > 200 ? `${errorText.slice(0, 197)}…` : errorText;

  const { data: processingRow, error: insertError } = await params.supabase
    .from("messages")
    .insert({
      business_id: params.businessId,
      customer_id: params.customerId,
      channel: "whatsapp",
      direction: "outbound",
      thread_id: params.threadId,
      normalised_text: `[Processing error] ${shortError}`,
      delivery_status: "failed_processing",
      delivery_error_code: "processing_error",
      delivery_error_text: shortError,
      delivery_audience: "buyer",
      delivery_attempts: 0,
      next_retry_at: null,
      raw_payload: {
        kind: "failed_processing",
        inbound_message_id: params.inboundMessageId,
        error: shortError,
      },
      media_urls: null,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("[inbound-crash] failed to record processing error", {
      error: insertError.message,
      original: shortError,
    });
  }

  const processingMessageId = (processingRow?.id as string | null) ?? null;

  const recentApology = await findRecentApology(
    params.supabase,
    params.customerId,
  );
  if (recentApology) {
    console.info("[inbound-crash] apology suppressed (cooldown)", {
      customerId: params.customerId,
      priorApologyId: recentApology,
    });
    return {
      recorded: Boolean(processingMessageId),
      processingMessageId,
      apologySent: false,
      apologySkipped: true,
      apologyMessageId: null,
      apologyError: null,
      errorText: shortError,
    };
  }

  const lang = await getCustomerPreferredLanguage(
    params.supabase,
    params.customerId,
  );
  const apologyText = t("support.processing_apology", lang);

  try {
    const sent = await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: params.customerPhoneE164,
      text: apologyText,
      threadId: params.threadId,
      customerId: params.customerId,
      supabase: params.supabase,
      audience: "buyer",
      retryContext: { kind: "generic" },
    });
    // Tag as apology for cooldown lookups (merge into existing payload).
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
            kind: "processing_apology",
            inbound_message_id: params.inboundMessageId,
          },
        })
        .eq("id", sent.messageId);
    }
    return {
      recorded: Boolean(processingMessageId),
      processingMessageId,
      apologySent: true,
      apologySkipped: false,
      apologyMessageId: sent.messageId || null,
      apologyError: null,
      errorText: shortError,
    };
  } catch (apologyErr) {
    const apologyError =
      apologyErr instanceof Error ? apologyErr.message : String(apologyErr);
    console.error("[inbound-crash] apology send failed (already persisted)", {
      customerId: params.customerId,
      error: apologyError,
    });
    return {
      recorded: Boolean(processingMessageId),
      processingMessageId,
      apologySent: false,
      apologySkipped: false,
      apologyMessageId: null,
      apologyError,
      errorText: shortError,
    };
  }
}

async function findRecentApology(
  supabase: SupabaseClient,
  customerId: string,
): Promise<string | null> {
  const since = new Date(Date.now() - APOLOGY_COOLDOWN_MS).toISOString();
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
    if (raw.kind === "processing_apology") return row.id as string;
    const text = (row.normalised_text as string | null) ?? "";
    if (
      /something went wrong on our side/i.test(text) ||
      /quelque chose a mal tourné de notre côté/i.test(text)
    ) {
      return row.id as string;
    }
  }
  return null;
}
