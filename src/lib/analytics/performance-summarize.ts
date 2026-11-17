import { inWindow, type UtcWindow } from "@/lib/analytics/ranges";
import type { LineItemRow, PaidOrderFact } from "@/lib/analytics/paid-orders";
import {
  averageOrderValue,
  totalsFor,
  type PeriodTotals,
} from "@/lib/analytics/summarize";
import {
  changeVersusPrior,
  iterateDayKeys,
  previousRollingWindow,
  rollingWindow,
  type PerformancePeriodDays,
} from "@/lib/analytics/performance-periods";
import { ORDER_STATUS } from "@/lib/orders/status";

export type StatusBucketKey =
  | "paid"
  | "dispatched"
  | "delivered"
  | "cancelled"
  | "refunded";

export type ChannelSplit = {
  whatsappCount: number;
  storefrontCount: number;
  otherCount: number;
  total: number;
  whatsappPercent: number | null;
  storefrontPercent: number | null;
};

export type DaySalesBar = {
  key: string;
  salesPence: number;
  orderCount: number;
};

export type PerformanceTopProduct = {
  productId: string | null;
  name: string;
  units: number;
  salesPence: number;
};

export type MetricWithChange = {
  value: number;
  previous: number;
  changePercent: number | null;
};

export type PerformanceSummary = {
  days: PerformancePeriodDays;
  currentWindow: UtcWindow;
  previousWindow: UtcWindow;
  empty: boolean;
  sales: MetricWithChange;
  orders: MetricWithChange;
  aov: MetricWithChange;
  refundAmountPence: MetricWithChange;
  refundCount: MetricWithChange;
  returnCount: MetricWithChange;
  statusCounts: Record<StatusBucketKey, number>;
  /** Cancelled unpaid/never-paid created in the current window. */
  cancelledUnpaidCount: number;
  topProducts: PerformanceTopProduct[];
  daily: DaySalesBar[];
  channel: ChannelSplit;
  currentFacts: PaidOrderFact[];
};

const RETURN_STATUSES = new Set<string>([
  ORDER_STATUS.RETURN_REQUESTED,
  ORDER_STATUS.RETURN_APPROVED,
  ORDER_STATUS.RETURN_DECLINED,
  ORDER_STATUS.RETURNED,
]);

function statusBucket(status: string): StatusBucketKey | null {
  switch (status) {
    case ORDER_STATUS.PAID:
      return "paid";
    case ORDER_STATUS.DISPATCHED:
      return "dispatched";
    case ORDER_STATUS.DELIVERED:
    case ORDER_STATUS.RETURN_REQUESTED:
    case ORDER_STATUS.RETURN_APPROVED:
    case ORDER_STATUS.RETURN_DECLINED:
    case ORDER_STATUS.RETURNED:
      return "delivered";
    case ORDER_STATUS.CANCELLED:
      return "cancelled";
    case ORDER_STATUS.REFUNDED:
    case ORDER_STATUS.PARTIALLY_REFUNDED:
    case ORDER_STATUS.REFUND_PENDING:
      return "refunded";
    default:
      return null;
  }
}

function metric(current: number, previous: number): MetricWithChange {
  return {
    value: current,
    previous,
    changePercent: changeVersusPrior(current, previous),
  };
}

function channelSplit(facts: PaidOrderFact[]): ChannelSplit {
  let whatsappCount = 0;
  let storefrontCount = 0;
  let otherCount = 0;
  for (const fact of facts) {
    if (fact.channel === "whatsapp") whatsappCount += 1;
    else if (fact.channel === "storefront") storefrontCount += 1;
    else otherCount += 1;
  }
  const total = facts.length;
  return {
    whatsappCount,
    storefrontCount,
    otherCount,
    total,
    whatsappPercent:
      total === 0 ? null : Math.round((whatsappCount / total) * 1000) / 10,
    storefrontPercent:
      total === 0 ? null : Math.round((storefrontCount / total) * 1000) / 10,
  };
}

function refundTotals(facts: PaidOrderFact[]): {
  amountPence: number;
  count: number;
} {
  let amountPence = 0;
  let count = 0;
  for (const fact of facts) {
    if (fact.refundedPence > 0) {
      amountPence += fact.refundedPence;
      count += 1;
    }
  }
  return { amountPence, count };
}

function returnCount(facts: PaidOrderFact[]): number {
  return facts.filter((f) => RETURN_STATUSES.has(f.status)).length;
}

function statusCounts(facts: PaidOrderFact[]): Record<StatusBucketKey, number> {
  const counts: Record<StatusBucketKey, number> = {
    paid: 0,
    dispatched: 0,
    delivered: 0,
    cancelled: 0,
    refunded: 0,
  };
  for (const fact of facts) {
    const bucket = statusBucket(fact.status);
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

/** Top products by units sold (then sales), net-scaled line revenue. */
export function topProductsByUnits(
  periodFacts: PaidOrderFact[],
  items: LineItemRow[],
  limit = 5,
): PerformanceTopProduct[] {
  const netByOrder = new Map(periodFacts.map((row) => [row.orderId, row]));
  const grouped = new Map<string, PerformanceTopProduct>();

  for (const item of items) {
    const order = netByOrder.get(item.orderId);
    if (!order) continue;
    const scale = order.totalPence > 0 ? order.netPence / order.totalPence : 0;
    const salesPence = Math.round(item.quantity * item.unitPricePence * scale);
    const key = item.productId ?? `name:${item.productName}`;
    const current = grouped.get(key) ?? {
      productId: item.productId,
      name: item.productName,
      units: 0,
      salesPence: 0,
    };
    current.units += item.quantity;
    current.salesPence += salesPence;
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .sort(
      (a, b) =>
        b.units - a.units ||
        b.salesPence - a.salesPence ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

function dailyBars(
  facts: PaidOrderFact[],
  window: UtcWindow,
): DaySalesBar[] {
  const byDay = new Map<string, PaidOrderFact[]>();
  for (const fact of facts) {
    const key = fact.paidAt.slice(0, 10);
    const list = byDay.get(key) ?? [];
    list.push(fact);
    byDay.set(key, list);
  }
  return iterateDayKeys(window).map((key) => {
    const dayFacts = byDay.get(key) ?? [];
    const totals = totalsFor(dayFacts);
    return {
      key,
      salesPence: totals.revenuePence,
      orderCount: totals.orderCount,
    };
  });
}

export function summarizePerformance(
  facts: PaidOrderFact[],
  items: LineItemRow[],
  days: PerformancePeriodDays,
  cancelledUnpaidInPeriod: number,
  now = new Date(),
): PerformanceSummary {
  const currentWindow_ = rollingWindow(days, now);
  const previousWindow_ = previousRollingWindow(currentWindow_);
  const currentFacts = facts.filter((row) =>
    inWindow(row.paidAt, currentWindow_),
  );
  const previousFacts = facts.filter((row) =>
    inWindow(row.paidAt, previousWindow_),
  );

  const current: PeriodTotals = totalsFor(currentFacts);
  const previous: PeriodTotals = totalsFor(previousFacts);
  const currentRefunds = refundTotals(currentFacts);
  const previousRefunds = refundTotals(previousFacts);
  const currentReturns = returnCount(currentFacts);
  const previousReturns = returnCount(previousFacts);
  const currentAov = averageOrderValue(current);
  const previousAov = averageOrderValue(previous);

  const status = statusCounts(currentFacts);
  status.cancelled += cancelledUnpaidInPeriod;

  return {
    days,
    currentWindow: currentWindow_,
    previousWindow: previousWindow_,
    empty: current.orderCount === 0,
    sales: metric(current.revenuePence, previous.revenuePence),
    orders: metric(current.orderCount, previous.orderCount),
    aov: metric(currentAov, previousAov),
    refundAmountPence: metric(
      currentRefunds.amountPence,
      previousRefunds.amountPence,
    ),
    refundCount: metric(currentRefunds.count, previousRefunds.count),
    returnCount: metric(currentReturns, previousReturns),
    statusCounts: status,
    cancelledUnpaidCount: cancelledUnpaidInPeriod,
    topProducts: topProductsByUnits(currentFacts, items, 5),
    daily: dailyBars(currentFacts, currentWindow_),
    channel: channelSplit(currentFacts),
    currentFacts,
  };
}
