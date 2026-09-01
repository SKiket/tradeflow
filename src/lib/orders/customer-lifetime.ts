import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Increment lifetime stats when an order first becomes PAID.
 *
 * Historical rows were never maintained — values before this runs are
 * incomplete. Do not call on already_fulfilled retries.
 */
export async function recordPaidCustomerLifetime(
  supabase: SupabaseClient,
  params: { customerId: string; totalPence: number; paidAt?: string },
): Promise<void> {
  const { data: customer, error: readError } = await supabase
    .from("customers")
    .select("order_count, lifetime_value_pence")
    .eq("id", params.customerId)
    .maybeSingle();

  if (readError) {
    throw new Error(`customer lifetime read failed: ${readError.message}`);
  }
  if (!customer) {
    throw new Error(`customer lifetime update skipped — missing ${params.customerId}`);
  }

  const { error: updateError } = await supabase
    .from("customers")
    .update({
      order_count: (customer.order_count ?? 0) + 1,
      lifetime_value_pence:
        (customer.lifetime_value_pence ?? 0) + params.totalPence,
      last_order_at: params.paidAt ?? new Date().toISOString(),
    })
    .eq("id", params.customerId);

  if (updateError) {
    throw new Error(`customer lifetime update failed: ${updateError.message}`);
  }
}
