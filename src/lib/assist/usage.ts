import type { SupabaseClient } from "@supabase/supabase-js";

import { ASSIST_DAILY_LIMIT } from "@/lib/assist/constants";

export async function assertUnderAssistLimit(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("ai_describe_usage")
    .select("assist_count")
    .eq("business_id", businessId)
    .eq("usage_date", today)
    .maybeSingle();
  const count = (data?.assist_count as number | undefined) ?? 0;
  if (count >= ASSIST_DAILY_LIMIT) {
    return {
      ok: false,
      error: `Daily assist limit of ${ASSIST_DAILY_LIMIT} reached. Try again tomorrow.`,
    };
  }
  return { ok: true };
}

export async function incrementAssistUsage(
  supabase: SupabaseClient,
  businessId: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("ai_describe_usage")
    .select("assist_count, suggestion_count")
    .eq("business_id", businessId)
    .eq("usage_date", today)
    .maybeSingle();
  if (data) {
    await supabase
      .from("ai_describe_usage")
      .update({ assist_count: ((data.assist_count as number) ?? 0) + 1 })
      .eq("business_id", businessId)
      .eq("usage_date", today);
  } else {
    await supabase.from("ai_describe_usage").insert({
      business_id: businessId,
      usage_date: today,
      suggestion_count: 0,
      assist_count: 1,
    });
  }
}
