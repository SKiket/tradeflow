import type { SupabaseClient } from "@supabase/supabase-js";

import { ORDER_STATUS } from "@/lib/orders/status";

/**
 * Orders awaiting seller approve/decline.
 * Shared by seller home attention and the Returns "Needs decision" tab
 * so the two counts can never disagree.
 */
export async function countReturnsNeedingDecision(
  supabase: SupabaseClient,
  businessId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", ORDER_STATUS.RETURN_REQUESTED)
    .is("deleted_at", null);

  if (error) {
    console.error("[returns] count needing decision", error.message);
    return 0;
  }
  return count ?? 0;
}
