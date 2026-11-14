import type { SupabaseClient } from "@supabase/supabase-js";

export interface DeliveryFailureSummary {
  count: number;
  latestErrorText: string | null;
}

/** Failed outbound WhatsApp in the last 24h for a business. */
export async function countRecentDeliveryFailures(
  supabase: SupabaseClient,
  businessId: string,
): Promise<DeliveryFailureSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .eq("delivery_status", "failed")
    .gte("created_at", since);

  if (countError) {
    console.error("[delivery-failures] count failed", countError.message);
    return { count: 0, latestErrorText: null };
  }

  const { data: latest } = await supabase
    .from("messages")
    .select("delivery_error_text")
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .eq("delivery_status", "failed")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    count: count ?? 0,
    latestErrorText:
      (latest?.delivery_error_text as string | null | undefined) ?? null,
  };
}
