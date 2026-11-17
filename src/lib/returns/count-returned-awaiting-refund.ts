import type { SupabaseClient } from "@supabase/supabase-js";

import { ORDER_STATUS } from "@/lib/orders/status";

/**
 * RETURNED orders that still need a refund decision.
 * Shared by seller home attention and the Returns closed tab filter.
 */
export async function countReturnedAwaitingRefund(
  supabase: SupabaseClient,
  businessId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", ORDER_STATUS.RETURNED)
    .not("return_requested_at", "is", null)
    .is("deleted_at", null);

  if (error) {
    console.error("[returns] count returned awaiting refund", error.message);
    return 0;
  }
  return count ?? 0;
}
