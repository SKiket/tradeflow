import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import type { DeliveryAudience } from "@/lib/channels/send/delivery";

const BATCH_LIMIT = 25;

export interface DeliveryRetryResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Re-attempt failed outbound WhatsApp rows whose next_retry_at has passed.
 * Uses minutes-scale backoff already stamped on the row; never hammers
 * Twilio — one attempt per due row per cron tick.
 */
export async function runWhatsAppDeliveryRetry(
  supabase: SupabaseClient,
): Promise<DeliveryRetryResult> {
  const now = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("messages")
    .select(
      "id, business_id, customer_id, thread_id, normalised_text, delivery_audience, delivery_attempts, raw_payload",
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

    attempted += 1;
    try {
      await sendWhatsAppMessage({
        businessId: row.business_id as string,
        toPhoneE164: to,
        text,
        threadId: row.thread_id as string | null,
        customerId: row.customer_id as string,
        supabase,
        audience: (row.delivery_audience as DeliveryAudience) || "buyer",
        existingMessageId: row.id as string,
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

  return { attempted, succeeded, failed, skipped };
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
