import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One row per order, keyed off the first transition INTO PAID in
 * order_status_history. Revenue is net of refunded_amount_pence.
 *
 * This is the dashboard source of truth. analytics_cache is a leftover
 * 3-day rolling snapshot and is not read for display.
 */
export type PaidOrderFact = {
  orderId: string;
  customerId: string | null;
  paidAt: string;
  totalPence: number;
  refundedPence: number;
  netPence: number;
};

export async function fetchPaidOrderFacts(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ facts: PaidOrderFact[]; error: string | null }> {
  const { data: history, error: histError } = await supabase
    .from("order_status_history")
    .select("order_id, changed_at")
    .eq("business_id", businessId)
    .eq("to_status", "PAID")
    .order("changed_at", { ascending: true });

  if (histError) {
    return { facts: [], error: histError.message };
  }

  const firstPaid = new Map<string, string>();
  for (const row of history ?? []) {
    const orderId = row.order_id as string;
    if (firstPaid.has(orderId)) continue;
    firstPaid.set(orderId, row.changed_at as string);
  }

  const orderIds = [...firstPaid.keys()];
  if (orderIds.length === 0) return { facts: [], error: null };

  const { data: orders, error: orderError } = await supabase
    .from("orders")
    .select("id, customer_id, total_pence, refunded_amount_pence")
    .eq("business_id", businessId)
    .in("id", orderIds)
    .is("deleted_at", null);

  if (orderError) {
    return { facts: [], error: orderError.message };
  }

  const facts: PaidOrderFact[] = [];
  for (const order of orders ?? []) {
    const paidAt = firstPaid.get(order.id as string);
    if (!paidAt) continue;
    const totalPence = (order.total_pence as number) ?? 0;
    const refundedPence = (order.refunded_amount_pence as number) ?? 0;
    facts.push({
      orderId: order.id as string,
      customerId: (order.customer_id as string | null) ?? null,
      paidAt,
      totalPence,
      refundedPence,
      netPence: Math.max(0, totalPence - refundedPence),
    });
  }

  facts.sort((a, b) => a.paidAt.localeCompare(b.paidAt) || a.orderId.localeCompare(b.orderId));
  return { facts, error: null };
}

export type LineItemRow = {
  orderId: string;
  quantity: number;
  unitPricePence: number;
  productId: string | null;
  productName: string;
};

export async function fetchPaidOrderItems(
  supabase: SupabaseClient,
  businessId: string,
  orderIds: string[],
): Promise<{ items: LineItemRow[]; error: string | null }> {
  if (orderIds.length === 0) return { items: [], error: null };

  const { data, error } = await supabase
    .from("order_items")
    .select(
      "order_id, quantity, unit_price_pence, product_variants(product_id, products(id, name))",
    )
    .eq("business_id", businessId)
    .in("order_id", orderIds);

  if (error) return { items: [], error: error.message };

  const items: LineItemRow[] = [];
  for (const row of data ?? []) {
    const variantRaw = row.product_variants as
      | { product_id: string | null; products: { id: string; name: string } | { id: string; name: string }[] | null }
      | { product_id: string | null; products: { id: string; name: string } | { id: string; name: string }[] | null }[]
      | null;
    const variant = Array.isArray(variantRaw) ? (variantRaw[0] ?? null) : variantRaw;
    const productRaw = variant?.products ?? null;
    const product = Array.isArray(productRaw) ? (productRaw[0] ?? null) : productRaw;
    items.push({
      orderId: row.order_id as string,
      quantity: (row.quantity as number) ?? 0,
      unitPricePence: (row.unit_price_pence as number) ?? 0,
      productId: product?.id ?? variant?.product_id ?? null,
      productName: product?.name?.trim() || "Unknown product",
    });
  }
  return { items, error: null };
}
