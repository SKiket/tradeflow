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
  /** Current order status (for status / returns breakdown). */
  status: string;
  /** Order channel: whatsapp | storefront | other. */
  channel: string;
};

export async function fetchPaidOrderFacts(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ facts: PaidOrderFact[]; error: string | null }> {
  // Paginate past the default 1000-row PostgREST cap.
  const PAGE = 1000;
  const history: { order_id: string; changed_at: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: histError } = await supabase
      .from("order_status_history")
      .select("order_id, changed_at")
      .eq("business_id", businessId)
      .eq("to_status", "PAID")
      .order("changed_at", { ascending: true })
      .order("order_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (histError) {
      return { facts: [], error: histError.message };
    }
    const page = data ?? [];
    for (const row of page) {
      history.push({
        order_id: row.order_id as string,
        changed_at: row.changed_at as string,
      });
    }
    if (page.length < PAGE) break;
  }

  const firstPaid = new Map<string, string>();
  for (const row of history) {
    const orderId = row.order_id;
    if (firstPaid.has(orderId)) continue;
    firstPaid.set(orderId, row.changed_at);
  }

  if (firstPaid.size === 0) return { facts: [], error: null };

  // One paginated scan of the shop's orders (avoids huge .in() URL lists).
  const orderById = new Map<
    string,
    {
      id: string;
      customer_id: string | null;
      total_pence: number | null;
      refunded_amount_pence: number | null;
      status: string | null;
      channel: string | null;
    }
  >();
  for (let from = 0; ; from += PAGE) {
    const { data, error: orderError } = await supabase
      .from("orders")
      .select(
        "id, customer_id, total_pence, refunded_amount_pence, status, channel",
      )
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (orderError) {
      return { facts: [], error: orderError.message };
    }
    const page = data ?? [];
    for (const row of page) {
      orderById.set(row.id as string, row as {
        id: string;
        customer_id: string | null;
        total_pence: number | null;
        refunded_amount_pence: number | null;
        status: string | null;
        channel: string | null;
      });
    }
    if (page.length < PAGE) break;
  }

  const facts: PaidOrderFact[] = [];
  for (const [orderId, paidAt] of firstPaid) {
    const order = orderById.get(orderId);
    if (!order) continue;
    const totalPence = (order.total_pence as number) ?? 0;
    const refundedPence = (order.refunded_amount_pence as number) ?? 0;
    const channelRaw = String(order.channel ?? "")
      .trim()
      .toLowerCase();
    const channel =
      channelRaw === "whatsapp" || channelRaw === "storefront"
        ? channelRaw
        : "other";
    facts.push({
      orderId,
      customerId: (order.customer_id as string | null) ?? null,
      paidAt,
      totalPence,
      refundedPence,
      netPence: Math.max(0, totalPence - refundedPence),
      status: String(order.status ?? ""),
      channel,
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

  const wanted = new Set(orderIds);
  // Paginate the shop's line items once, then keep rows for the requested orders.
  // Avoids hundreds of .in() round-trips on large period sets.
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("order_items")
      .select(
        "order_id, quantity, unit_price_pence, product_variants(product_id, products(id, name))",
      )
      .eq("business_id", businessId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { items: [], error: error.message };
    const page = data ?? [];
    for (const row of page) {
      if (wanted.has(row.order_id as string)) {
        rows.push(row as Record<string, unknown>);
      }
    }
    if (page.length < PAGE) break;
  }

  const items: LineItemRow[] = [];
  for (const row of rows) {
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
