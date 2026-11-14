import type { SupabaseClient } from "@supabase/supabase-js";

import type { DeliveryAudience } from "@/lib/channels/send/delivery";
import {
  evaluateOutboundRetry,
  markOutboundTerminal,
} from "@/lib/channels/send/retry-eligibility";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";

const BATCH_LIMIT = 25;

export interface DeliveryRetryResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  superseded: number;
  expired: number;
}

/**
 * Re-attempt failed outbound WhatsApp rows whose next_retry_at has passed.
 *
 * Before sending, validates the queued text still matches current order/thread
 * state. Stale rows become "superseded"; rows older than 12h become "expired".
 * Never hammers Twilio — one attempt per due row per cron tick.
 */
export async function runWhatsAppDeliveryRetry(
  supabase: SupabaseClient,
): Promise<DeliveryRetryResult> {
  const now = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("messages")
    .select(
      "id, business_id, customer_id, thread_id, normalised_text, delivery_audience, delivery_attempts, raw_payload, created_at",
    )
    .eq("direction", "outbound")
    .eq("delivery_status", "failed")
    .not("next_retry_at", "is", null)
    .lte("next_retry_at", now)
    .order("next_retry_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new Error(`delivery retry lookup failed: ${error.message}`);
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let superseded = 0;
  let expired = 0;

  for (const row of due ?? []) {
    const text = (row.normalised_text as string | null)?.trim();
    const raw = (row.raw_payload ?? {}) as Record<string, unknown>;
    const to =
      typeof raw.to === "string"
        ? raw.to
        : await lookupCustomerPhone(supabase, row.customer_id as string);

    if (!text || !to) {
      skipped += 1;
      await supabase
        .from("messages")
        .update({ next_retry_at: null })
        .eq("id", row.id);
      continue;
    }

    // Claim this row so concurrent cron ticks don't double-send.
    const { data: claimed } = await supabase
      .from("messages")
      .update({ next_retry_at: null })
      .eq("id", row.id)
      .eq("delivery_status", "failed")
      .select("id")
      .maybeSingle();
    if (!claimed) {
      skipped += 1;
      continue;
    }

    const decision = await evaluateOutboundRetry({
      supabase,
      messageId: row.id as string,
      businessId: row.business_id as string,
      threadId: (row.thread_id as string | null) ?? null,
      customerId: row.customer_id as string,
      createdAt: row.created_at as string,
      normalisedText: text,
      rawPayload: raw,
    });

    if (decision.action === "expired") {
      await markOutboundTerminal(
        supabase,
        row.id as string,
        "expired",
        decision.reason,
      );
      expired += 1;
      console.info("[delivery-retry] expired", {
        messageId: row.id,
        reason: decision.reason,
      });
      continue;
    }

    if (decision.action === "superseded") {
      await markOutboundTerminal(
        supabase,
        row.id as string,
        "superseded",
        decision.reason,
      );
      superseded += 1;
      console.info("[delivery-retry] superseded — not sending stale text", {
        messageId: row.id,
        reason: decision.reason,
        queuedTextPreview: text.slice(0, 80),
      });
      continue;
    }

    // Eligible: re-send the exact queued text (still matches current state).
    attempted += 1;
    try {
      const retryContext =
        raw.retry_context && typeof raw.retry_context === "object"
          ? (raw.retry_context as import("@/lib/channels/send/delivery").RetryContext)
          : null;
      await sendWhatsAppMessage({
        businessId: row.business_id as string,
        toPhoneE164: to,
        text,
        threadId: row.thread_id as string | null,
        customerId: row.customer_id as string,
        supabase,
        audience: (row.delivery_audience as DeliveryAudience) || "buyer",
        existingMessageId: row.id as string,
        retryContext,
      });
      succeeded += 1;
    } catch (err) {
      failed += 1;
      console.error("[delivery-retry] re-send failed", {
        messageId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { attempted, succeeded, failed, skipped, superseded, expired };
}

async function lookupCustomerPhone(
  supabase: SupabaseClient,
  customerId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("customers")
    .select("phone_e164")
    .eq("id", customerId)
    .maybeSingle();
  return (data?.phone_e164 as string | null) ?? null;
}
