import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenDisputeStatus } from "@/lib/disputes/constants";

/**
 * True when any dispute on the given orders (or business) is still open
 * (status not won/lost/warning_closed/prevented).
 */
export async function findOpenDisputesForOrders(
  supabase: SupabaseClient,
  params: { businessId: string; orderIds: string[] },
): Promise<{ orderId: string; orderRef: string | null; status: string }[]> {
  if (params.orderIds.length === 0) return [];

  const { data, error } = await supabase
    .from("disputes")
    .select("order_id, status, orders(order_ref)")
    .eq("business_id", params.businessId)
    .in("order_id", params.orderIds)
    .is("closed_at", null);

  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter((row) => isOpenDisputeStatus(row.status as string))
    .map((row) => {
      const orders = row.orders as
        | { order_ref: string }
        | { order_ref: string }[]
        | null;
      const ref = Array.isArray(orders)
        ? orders[0]?.order_ref
        : orders?.order_ref;
      return {
        orderId: row.order_id as string,
        orderRef: ref ?? null,
        status: row.status as string,
      };
    });
}

export async function businessHasOpenDispute(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ hasOpen: boolean; orderRefs: string[] }> {
  const { data, error } = await supabase
    .from("disputes")
    .select("id, status, orders(order_ref)")
    .eq("business_id", businessId)
    .is("closed_at", null);

  if (error) throw new Error(error.message);

  const open = (data ?? []).filter((row) =>
    isOpenDisputeStatus(row.status as string),
  );
  const orderRefs = open
    .map((row) => {
      const orders = row.orders as
        | { order_ref: string }
        | { order_ref: string }[]
        | null;
      return Array.isArray(orders)
        ? orders[0]?.order_ref
        : orders?.order_ref;
    })
    .filter((r): r is string => typeof r === "string" && r.length > 0);

  return { hasOpen: open.length > 0, orderRefs };
}

export async function orderHasOpenDispute(
  supabase: SupabaseClient,
  params: { businessId: string; orderId: string },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("disputes")
    .select("id, status")
    .eq("business_id", params.businessId)
    .eq("order_id", params.orderId)
    .is("closed_at", null)
    .limit(5);

  if (error) throw new Error(error.message);
  return (data ?? []).some((row) => isOpenDisputeStatus(row.status as string));
}

export async function countOpenDisputes(
  supabase: SupabaseClient,
  businessId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("disputes")
    .select("id, status")
    .eq("business_id", businessId)
    .is("closed_at", null);

  if (error) throw new Error(error.message);
  return (data ?? []).filter((row) =>
    isOpenDisputeStatus(row.status as string),
  ).length;
}
