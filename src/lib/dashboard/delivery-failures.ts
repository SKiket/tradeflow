import type { SupabaseClient } from "@supabase/supabase-js";

const BANNER_STATUSES = ["failed", "expired", "failed_processing"] as const;

export interface DeliveryFailureSummary {
  count: number;
  latestErrorText: string | null;
}

/**
 * Unacknowledged delivery / processing failures for the dashboard banner.
 * Includes failed, expired, and failed_processing. Superseded is Inbox-only.
 */
export async function countRecentDeliveryFailures(
  supabase: SupabaseClient,
  businessId: string,
): Promise<DeliveryFailureSummary> {
  const { count, error: countError } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .in("delivery_status", [...BANNER_STATUSES])
    .is("delivery_acknowledged_at", null);

  if (countError) {
    console.error("[delivery-failures] count failed", countError.message);
    return { count: 0, latestErrorText: null };
  }

  const { data: latest } = await supabase
    .from("messages")
    .select("delivery_error_text, delivery_status")
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .in("delivery_status", [...BANNER_STATUSES])
    .is("delivery_acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    count: count ?? 0,
    latestErrorText:
      (latest?.delivery_error_text as string | null | undefined) ?? null,
  };
}

/** Mark all unacked banner rows for a business as dismissed. */
export async function acknowledgeDeliveryFailures(
  supabase: SupabaseClient,
  businessId: string,
): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("messages")
    .update({ delivery_acknowledged_at: now })
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .in("delivery_status", [...BANNER_STATUSES])
    .is("delivery_acknowledged_at", null)
    .select("id");
  if (error) {
    throw new Error(error.message);
  }
  return data?.length ?? 0;
}

/** When the seller replies on a thread, clear banner items for that thread. */
export async function acknowledgeThreadDeliveryFailures(
  supabase: SupabaseClient,
  businessId: string,
  threadId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("messages")
    .update({ delivery_acknowledged_at: now })
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .eq("direction", "outbound")
    .in("delivery_status", [...BANNER_STATUSES])
    .is("delivery_acknowledged_at", null);
}
