import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Seller/business language for template lookup.
 * Uses preferred_language / language / seller_language when present on
 * businesses; otherwise null (caller falls back to English).
 */
export async function getBusinessSellerLanguage(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  for (const key of ["preferred_language", "language", "seller_language"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
