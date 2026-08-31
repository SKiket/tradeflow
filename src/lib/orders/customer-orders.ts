import type { SupabaseClient } from "@supabase/supabase-js";

import { unwrapRelation } from "@/lib/orders/display";
import { ORDER_STATUS } from "@/lib/orders/status";

const DEFAULT_LIMIT = 5;

const EXCLUDED_STATUSES: string[] = [
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.EXPIRED,
];

export type CustomerOrderItem = {
  productName: string;
  variantLabel: string | null;
  quantity: number;
};

export type CustomerOrderSummary = {
  orderRef: string;
  status: string;
  createdAt: string;
  items: CustomerOrderItem[];
  carrier: string | null;
  trackingNumber: string | null;
};

type VariantJoin = {
  label: string | null;
  products: { name: string } | { name: string }[] | null;
} | null;

/**
 * Recent orders for one customer at one business.
 *
 * Same item/dispatch column pattern as the dashboard detail and public
 * tracking page. Excludes CANCELLED and EXPIRED so support_reply only
 * sees live (or paid/refund) history.
 */
export async function fetchRecentCustomerOrders(
  supabase: SupabaseClient,
  params: { businessId: string; customerId: string; limit?: number },
): Promise<CustomerOrderSummary[]> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  const { data: orders, error } = await supabase
    .from("orders")
    .select(
      "id, order_ref, status, created_at, dispatch_carrier, dispatch_tracking_number",
    )
    .eq("business_id", params.businessId)
    .eq("customer_id", params.customerId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(Math.max(limit * 2, 10));

  if (error) {
    throw new Error(`customer orders lookup failed: ${error.message}`);
  }

  const rows = (orders ?? []).filter(
    (row) => !EXCLUDED_STATUSES.includes(row.status as string),
  ).slice(0, limit);
  if (rows.length === 0) return [];

  const orderIds = rows.map((row) => row.id as string);
  const { data: itemRows, error: itemError } = await supabase
    .from("order_items")
    .select("order_id, quantity, product_variants(label, products(name))")
    .in("order_id", orderIds)
    .order("created_at", { ascending: true });

  if (itemError) {
    throw new Error(`customer order items lookup failed: ${itemError.message}`);
  }

  const itemsByOrder = new Map<string, CustomerOrderItem[]>();
  for (const row of itemRows ?? []) {
    const orderId = row.order_id as string;
    const variant = unwrapRelation(
      row.product_variants as VariantJoin | VariantJoin[],
    );
    const product = unwrapRelation(variant?.products);
    const list = itemsByOrder.get(orderId) ?? [];
    list.push({
      productName: product?.name ?? "Item",
      variantLabel: variant?.label ?? null,
      quantity: row.quantity as number,
    });
    itemsByOrder.set(orderId, list);
  }

  return rows.map((row) => ({
    orderRef: row.order_ref as string,
    status: row.status as string,
    createdAt: row.created_at as string,
    items: itemsByOrder.get(row.id as string) ?? [],
    carrier: (row.dispatch_carrier as string | null)?.trim() || null,
    trackingNumber:
      (row.dispatch_tracking_number as string | null)?.trim() || null,
  }));
}
