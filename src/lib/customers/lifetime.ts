import { ORDER_STATUS } from "@/lib/orders/status";

/**
 * Orders that count toward customer lifetime stats.
 *
 * Matches "has been paid": PAID and every status that can follow it,
 * including refunds. Unpaid drafts, expired checkouts, and cancels do not.
 *
 * The customers.order_count / lifetime_value_pence / last_order_at columns
 * are leftovers from Step 2 and are not the source of truth — the dashboard
 * computes these live from orders.
 */
export const CUSTOMER_LIFETIME_STATUSES = [
  ORDER_STATUS.PAID,
  ORDER_STATUS.DISPATCHED,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.RETURN_REQUESTED,
  ORDER_STATUS.RETURN_APPROVED,
  ORDER_STATUS.RETURN_DECLINED,
  ORDER_STATUS.RETURNED,
  ORDER_STATUS.REFUND_PENDING,
  ORDER_STATUS.PARTIALLY_REFUNDED,
  ORDER_STATUS.REFUNDED,
] as const;

export type CustomerLifetimeOrder = {
  customer_id?: string | null;
  status: string;
  total_pence: number;
  refunded_amount_pence?: number | null;
  created_at: string;
};

export type CustomerLifetimeStats = {
  order_count: number;
  lifetime_value_pence: number;
  last_order_at: string | null;
};

export const EMPTY_CUSTOMER_LIFETIME: CustomerLifetimeStats = {
  order_count: 0,
  lifetime_value_pence: 0,
  last_order_at: null,
};

export function isCustomerLifetimeStatus(status: string): boolean {
  return (CUSTOMER_LIFETIME_STATUSES as readonly string[]).includes(status);
}

export function summarizeCustomerLifetime(
  orders: CustomerLifetimeOrder[],
): CustomerLifetimeStats {
  let order_count = 0;
  let lifetime_value_pence = 0;
  let last_order_at: string | null = null;

  for (const order of orders) {
    if (!isCustomerLifetimeStatus(order.status)) continue;
    order_count += 1;
    const refunded = order.refunded_amount_pence ?? 0;
    lifetime_value_pence += Math.max(0, (order.total_pence ?? 0) - refunded);
    if (!last_order_at || order.created_at > last_order_at) {
      last_order_at = order.created_at;
    }
  }

  return { order_count, lifetime_value_pence, last_order_at };
}

export function lifetimeByCustomerId(
  orders: Array<CustomerLifetimeOrder & { customer_id: string | null }>,
): Map<string, CustomerLifetimeStats> {
  const grouped = new Map<string, CustomerLifetimeOrder[]>();
  for (const order of orders) {
    if (!order.customer_id) continue;
    const list = grouped.get(order.customer_id) ?? [];
    list.push(order);
    grouped.set(order.customer_id, list);
  }

  const result = new Map<string, CustomerLifetimeStats>();
  for (const [id, list] of grouped) {
    result.set(id, summarizeCustomerLifetime(list));
  }
  return result;
}

export function compareCustomersByRecentActivity(
  a: { last_order_at: string | null; created_at?: string | null },
  b: { last_order_at: string | null; created_at?: string | null },
): number {
  if (a.last_order_at && b.last_order_at) {
    if (a.last_order_at !== b.last_order_at) {
      return a.last_order_at > b.last_order_at ? -1 : 1;
    }
  } else if (a.last_order_at) {
    return -1;
  } else if (b.last_order_at) {
    return 1;
  }
  const aCreated = a.created_at ?? "";
  const bCreated = b.created_at ?? "";
  if (aCreated === bCreated) return 0;
  return aCreated > bCreated ? -1 : 1;
}
