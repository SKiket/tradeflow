import type { SupabaseClient } from "@supabase/supabase-js";

import { ORDER_STATUS } from "@/lib/orders/status";
import { countReturnsNeedingDecision } from "@/lib/returns/count-pending";

export const RETURNS_PAGE_SIZE = 25;

export const RETURNS_TABS = [
  "needs_decision",
  "approved",
  "declined",
  "closed",
] as const;

export type ReturnsTab = (typeof RETURNS_TABS)[number];

export type ReturnsRefundStatus = "none" | "partial" | "full";

export type ReturnListRow = {
  id: string;
  orderRef: string;
  status: string;
  returnReason: string | null;
  returnReasonDetail: string | null;
  returnRequestedAt: string | null;
  refundedPence: number;
  totalPence: number;
  refundStatus: ReturnsRefundStatus;
  itemSummary: string;
  customerInitials: string | null;
};

export type ReturnsListResult = {
  tab: ReturnsTab;
  page: number;
  pageSize: number;
  total: number;
  totals: Record<ReturnsTab, number>;
  rows: ReturnListRow[];
  error: string | null;
  /** Wall-clock ms for the list query set (counts + page). */
  queryMs: number;
};

const TAB_STATUSES: Record<ReturnsTab, string[]> = {
  needs_decision: [ORDER_STATUS.RETURN_REQUESTED],
  approved: [ORDER_STATUS.RETURN_APPROVED],
  declined: [ORDER_STATUS.RETURN_DECLINED],
  closed: [
    ORDER_STATUS.RETURNED,
    ORDER_STATUS.REFUND_PENDING,
    ORDER_STATUS.REFUNDED,
    ORDER_STATUS.PARTIALLY_REFUNDED,
  ],
};

export function parseReturnsTab(value: string | undefined): ReturnsTab {
  if (
    value === "needs_decision" ||
    value === "approved" ||
    value === "declined" ||
    value === "closed"
  ) {
    return value;
  }
  return "needs_decision";
}

export function parseReturnsPage(value: string | undefined): number {
  const n = Number.parseInt(value ?? "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 10_000);
}

function refundStatus(
  totalPence: number,
  refundedPence: number,
): ReturnsRefundStatus {
  if (refundedPence <= 0) return "none";
  if (totalPence > 0 && refundedPence >= totalPence) return "full";
  return "partial";
}

function initialsFromName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]!.slice(0, 1)}${parts[parts.length - 1]!.slice(0, 1)}`.toUpperCase();
}

function summariseItems(
  items: { quantity: number; name: string }[],
): string {
  if (items.length === 0) return "";
  const parts = items.slice(0, 2).map((item) => {
    const label = item.name.trim() || "Item";
    return item.quantity > 1 ? `${item.quantity}× ${label}` : label;
  });
  if (items.length > 2) parts.push(`+${items.length - 2}`);
  return parts.join(", ");
}

async function countTab(
  supabase: SupabaseClient,
  businessId: string,
  tab: ReturnsTab,
): Promise<number> {
  if (tab === "needs_decision") {
    return countReturnsNeedingDecision(supabase, businessId);
  }
  const statuses = TAB_STATUSES[tab];
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .in("status", statuses)
    .not("return_requested_at", "is", null)
    .is("deleted_at", null);
  if (error) {
    console.error(`[returns] count ${tab}`, error.message);
    return 0;
  }
  return count ?? 0;
}

export async function fetchReturnsList(
  supabase: SupabaseClient,
  businessId: string,
  tab: ReturnsTab,
  page: number,
): Promise<ReturnsListResult> {
  const t0 = Date.now();
  const pageSize = RETURNS_PAGE_SIZE;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const ascending = tab === "needs_decision";

  // Closed/approved/declined must have been return requests; needs_decision is
  // status-only (same filter as attention count).
  let listQuery = supabase
    .from("orders")
    .select(
      "id, order_ref, status, return_reason, return_reason_detail, return_requested_at, refunded_amount_pence, total_pence, customers(name)",
      { count: "exact" },
    )
    .eq("business_id", businessId)
    .in("status", TAB_STATUSES[tab])
    .is("deleted_at", null);

  if (tab !== "needs_decision") {
    listQuery = listQuery.not("return_requested_at", "is", null);
  }

  const [listRes, needs, approved, declined, closed] = await Promise.all([
    listQuery
      .order("return_requested_at", { ascending })
      .range(from, to),
    countTab(supabase, businessId, "needs_decision"),
    countTab(supabase, businessId, "approved"),
    countTab(supabase, businessId, "declined"),
    countTab(supabase, businessId, "closed"),
  ]);

  if (listRes.error) {
    return {
      tab,
      page,
      pageSize,
      total: 0,
      totals: {
        needs_decision: needs,
        approved,
        declined,
        closed,
      },
      rows: [],
      error: listRes.error.message,
      queryMs: Date.now() - t0,
    };
  }

  const rawRows = listRes.data ?? [];
  const orderIds = rawRows.map((row) => row.id as string);

  const itemNames = new Map<string, { quantity: number; name: string }[]>();
  if (orderIds.length > 0) {
    const { data: items, error: itemsError } = await supabase
      .from("order_items")
      .select(
        "order_id, quantity, product_variants(products(name))",
      )
      .eq("business_id", businessId)
      .in("order_id", orderIds);
    if (itemsError) {
      console.error("[returns] items", itemsError.message);
    } else {
      for (const row of items ?? []) {
        const orderId = row.order_id as string;
        const variantRaw = row.product_variants as
          | { products: { name: string } | { name: string }[] | null }
          | { products: { name: string } | { name: string }[] | null }[]
          | null;
        const variant = Array.isArray(variantRaw)
          ? (variantRaw[0] ?? null)
          : variantRaw;
        const productRaw = variant?.products ?? null;
        const product = Array.isArray(productRaw)
          ? (productRaw[0] ?? null)
          : productRaw;
        const list = itemNames.get(orderId) ?? [];
        list.push({
          quantity: (row.quantity as number) ?? 0,
          name: product?.name?.trim() || "Item",
        });
        itemNames.set(orderId, list);
      }
    }
  }

  const rows: ReturnListRow[] = rawRows.map((row) => {
    const customerRaw = row.customers as
      | { name: string | null }
      | { name: string | null }[]
      | null;
    const customer = Array.isArray(customerRaw)
      ? (customerRaw[0] ?? null)
      : customerRaw;
    const totalPence = (row.total_pence as number) ?? 0;
    const refundedPence = (row.refunded_amount_pence as number) ?? 0;
    return {
      id: row.id as string,
      orderRef: row.order_ref as string,
      status: row.status as string,
      returnReason: (row.return_reason as string | null) ?? null,
      returnReasonDetail: (row.return_reason_detail as string | null) ?? null,
      returnRequestedAt: (row.return_requested_at as string | null) ?? null,
      refundedPence,
      totalPence,
      refundStatus: refundStatus(totalPence, refundedPence),
      itemSummary: summariseItems(itemNames.get(row.id as string) ?? []),
      customerInitials: initialsFromName(customer?.name ?? null),
    };
  });

  return {
    tab,
    page,
    pageSize,
    total: listRes.count ?? rows.length,
    totals: {
      needs_decision: needs,
      approved,
      declined,
      closed,
    },
    rows,
    error: null,
    queryMs: Date.now() - t0,
  };
}
