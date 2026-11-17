import type { SupabaseClient } from "@supabase/supabase-js";

import { OPEN_DISPUTE_STATUSES } from "@/lib/disputes/constants";
import { ORDER_STATUS } from "@/lib/orders/status";
import { countReturnsNeedingDecision } from "@/lib/returns/count-pending";
import { countReturnedAwaitingRefund } from "@/lib/returns/count-returned-awaiting-refund";
import { canTakeCardPayments } from "@/lib/stripe/connect-capabilities";

export type SellerAttentionKind =
  | "disputes"
  | "fraud"
  | "returns"
  | "returned_awaiting_refund"
  | "payments_setup"
  | "undispatched"
  | "reminder_failed"
  | "delivery_failed"
  | "low_stock"
  | "knowledge_gaps";

export type SellerAttentionItem = {
  kind: SellerAttentionKind;
  count: number;
  href: string;
  /** ISO timestamp of oldest item in this bucket, when known (for ordering within). */
  oldestAt: string | null;
  /** Extra detail for the one-line reason (e.g. evidence deadline). */
  detail: string | null;
};

export type SellerAttentionBusiness = {
  id: string;
  stripe_connected_account_id: string | null;
  stripe_charges_enabled: boolean | null;
  stripe_transfers_capability_active: boolean | null;
};

/** Urgency order for the home attention list. */
export const SELLER_ATTENTION_ORDER: SellerAttentionKind[] = [
  "disputes",
  "fraud",
  "returns",
  "returned_awaiting_refund",
  "payments_setup",
  "undispatched",
  "reminder_failed",
  "delivery_failed",
  "low_stock",
  "knowledge_gaps",
];

const DELIVERY_FAIL_STATUSES = ["failed", "expired", "failed_processing"] as const;

async function countHead(
  promise: PromiseLike<{ count: number | null; error: { message: string } | null }>,
  label: string,
): Promise<number> {
  const { count, error } = await promise;
  if (error) {
    console.error(`[seller-attention] ${label}`, error.message);
    return 0;
  }
  return count ?? 0;
}

/**
 * One server-side pass of attention counts for the seller home.
 * Read-only. Uses head counts / small variant scans — safe for large order tables.
 */
export async function fetchSellerAttention(
  supabase: SupabaseClient,
  business: SellerAttentionBusiness,
): Promise<SellerAttentionItem[]> {
  const businessId = business.id;

  const [
    disputesCount,
    disputeOldestRes,
    fraudCount,
    fraudOldestRes,
    returnsCount,
    returnedAwaitingRefundCount,
    undispatchedCount,
    reminderFailedCount,
    deliveryFailedCount,
    lowStockVariants,
    gapsCount,
  ] = await Promise.all([
    countHead(
      supabase
        .from("disputes")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .is("closed_at", null)
        .in("status", [...OPEN_DISPUTE_STATUSES]),
      "disputes",
    ),
    supabase
      .from("disputes")
      .select("evidence_due_by, created_at")
      .eq("business_id", businessId)
      .is("closed_at", null)
      .in("status", [...OPEN_DISPUTE_STATUSES])
      .order("evidence_due_by", { ascending: true })
      .limit(1)
      .maybeSingle(),
    countHead(
      supabase
        .from("fraud_warnings")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("status", "open")
        .eq("actionable", true),
      "fraud",
    ),
    supabase
      .from("fraud_warnings")
      .select("order_id, created_at")
      .eq("business_id", businessId)
      .eq("status", "open")
      .eq("actionable", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    countReturnsNeedingDecision(supabase, businessId),
    countReturnedAwaitingRefund(supabase, businessId),
    countHead(
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("status", ORDER_STATUS.PAID)
        .is("deleted_at", null),
      "undispatched",
    ),
    countHead(
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .is("deleted_at", null)
        .or(
          "payment_reminder_12h_outcome.eq.failed,payment_reminder_23h_outcome.eq.failed",
        ),
      "reminder_failed",
    ),
    countHead(
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("direction", "outbound")
        .in("delivery_status", [...DELIVERY_FAIL_STATUSES])
        .is("delivery_acknowledged_at", null),
      "delivery_failed",
    ),
    supabase
      .from("product_variants")
      .select("stock_quantity, reserved_quantity, low_stock_threshold")
      .eq("business_id", businessId)
      .eq("track_inventory", true)
      .is("deleted_at", null),
    countHead(
      supabase
        .from("ai_knowledge_gaps")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("status", "open"),
      "gaps",
    ),
  ]);

  if (disputeOldestRes.error) {
    console.error(
      "[seller-attention] dispute oldest",
      disputeOldestRes.error.message,
    );
  }
  const oldestDisputeDue =
    (disputeOldestRes.data?.evidence_due_by as string | null | undefined) ??
    null;
  const oldestDisputeCreated =
    (disputeOldestRes.data?.created_at as string | null | undefined) ?? null;
  if (fraudOldestRes.error) {
    console.error("[seller-attention] fraud oldest", fraudOldestRes.error.message);
  }
  const oldestFraudOrderId =
    (fraudOldestRes.data?.order_id as string | null | undefined) ?? null;
  const oldestFraudAt =
    (fraudOldestRes.data?.created_at as string | null | undefined) ?? null;

  let lowStockCount = 0;
  if (lowStockVariants.error) {
    console.error("[seller-attention] low_stock", lowStockVariants.error.message);
  } else {
    for (const row of lowStockVariants.data ?? []) {
      const left =
        Number(row.stock_quantity ?? 0) - Number(row.reserved_quantity ?? 0);
      const threshold = Number(row.low_stock_threshold ?? 0);
      if (left <= threshold) lowStockCount += 1;
    }
  }

  const paymentsSetupNeeded = !canTakeCardPayments({
    stripe_connected_account_id: business.stripe_connected_account_id,
    stripe_charges_enabled: business.stripe_charges_enabled,
    stripe_transfers_capability_active:
      business.stripe_transfers_capability_active,
  });

  const items: SellerAttentionItem[] = [];

  if (disputesCount > 0) {
    items.push({
      kind: "disputes",
      count: disputesCount,
      href: "/dashboard/disputes",
      oldestAt: oldestDisputeDue ?? oldestDisputeCreated,
      detail: oldestDisputeDue,
    });
  }
  if (fraudCount > 0) {
    items.push({
      kind: "fraud",
      count: fraudCount,
      href: oldestFraudOrderId
        ? `/dashboard/orders/${oldestFraudOrderId}`
        : "/dashboard/orders",
      oldestAt: oldestFraudAt,
      detail: null,
    });
  }
  if (returnsCount > 0) {
    items.push({
      kind: "returns",
      count: returnsCount,
      href: "/dashboard/returns?tab=needs_decision",
      oldestAt: null,
      detail: null,
    });
  }
  if (returnedAwaitingRefundCount > 0) {
    items.push({
      kind: "returned_awaiting_refund",
      count: returnedAwaitingRefundCount,
      href: "/dashboard/returns?tab=closed",
      oldestAt: null,
      detail: null,
    });
  }
  if (paymentsSetupNeeded) {
    items.push({
      kind: "payments_setup",
      count: 1,
      href: "/dashboard/settings#stripe",
      oldestAt: null,
      detail: null,
    });
  }
  if (undispatchedCount > 0) {
    items.push({
      kind: "undispatched",
      count: undispatchedCount,
      href: "/dashboard/orders?status=PAID",
      oldestAt: null,
      detail: null,
    });
  }
  if (reminderFailedCount > 0) {
    items.push({
      kind: "reminder_failed",
      count: reminderFailedCount,
      href: "/dashboard/orders?status=AWAITING_PAYMENT",
      oldestAt: null,
      detail: null,
    });
  }
  if (deliveryFailedCount > 0) {
    items.push({
      kind: "delivery_failed",
      count: deliveryFailedCount,
      href: "/dashboard/inbox",
      oldestAt: null,
      detail: null,
    });
  }
  if (lowStockCount > 0) {
    items.push({
      kind: "low_stock",
      count: lowStockCount,
      href: "/dashboard/products",
      oldestAt: null,
      detail: null,
    });
  }
  if (gapsCount > 0) {
    items.push({
      kind: "knowledge_gaps",
      count: gapsCount,
      href: "/dashboard/knowledge-gaps",
      oldestAt: null,
      detail: null,
    });
  }

  const rank = new Map(
    SELLER_ATTENTION_ORDER.map((kind, index) => [kind, index]),
  );
  items.sort((a, b) => (rank.get(a.kind) ?? 99) - (rank.get(b.kind) ?? 99));
  return items;
}
