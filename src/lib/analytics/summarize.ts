import {
  bucketKey,
  currentWindow,
  formatBucketLabel,
  formatPercentChange,
  inWindow,
  iterateBucketKeys,
  percentChange,
  previousWindow,
  type AnalyticsRange,
} from "@/lib/analytics/ranges";
import type { LineItemRow, PaidOrderFact } from "@/lib/analytics/paid-orders";

export type PeriodTotals = {
  orderCount: number;
  revenuePence: number;
};

export type AnalyticsBucket = PeriodTotals & {
  key: string;
  label: string;
};

export type NewVsRepeatSplit = {
  newRevenuePence: number;
  repeatRevenuePence: number;
  newOrderCount: number;
  repeatOrderCount: number;
  repeatSharePercent: number;
};

export type TopProductRow = {
  productId: string | null;
  name: string;
  revenuePence: number;
  quantity: number;
};

export function emptyTotals(): PeriodTotals {
  return { orderCount: 0, revenuePence: 0 };
}

export function totalsFor(facts: PaidOrderFact[]): PeriodTotals {
  return {
    orderCount: facts.length,
    revenuePence: facts.reduce((sum, row) => sum + row.netPence, 0),
  };
}

export function averageOrderValue(totals: PeriodTotals): number {
  if (totals.orderCount === 0) return 0;
  return Math.round(totals.revenuePence / totals.orderCount);
}

export function firstPaidByCustomer(
  facts: PaidOrderFact[],
): Map<string, string> {
  const first = new Map<string, string>();
  for (const fact of facts) {
    if (!fact.customerId) continue;
    if (!first.has(fact.customerId)) first.set(fact.customerId, fact.orderId);
  }
  return first;
}

export function newVsRepeatSplit(
  periodFacts: PaidOrderFact[],
  allFacts: PaidOrderFact[],
): NewVsRepeatSplit {
  const first = firstPaidByCustomer(allFacts);
  let newRevenuePence = 0;
  let repeatRevenuePence = 0;
  let newOrderCount = 0;
  let repeatOrderCount = 0;

  for (const fact of periodFacts) {
    const isNew =
      !fact.customerId || first.get(fact.customerId) === fact.orderId;
    if (isNew) {
      newRevenuePence += fact.netPence;
      newOrderCount += 1;
    } else {
      repeatRevenuePence += fact.netPence;
      repeatOrderCount += 1;
    }
  }

  const revenue = newRevenuePence + repeatRevenuePence;
  return {
    newRevenuePence,
    repeatRevenuePence,
    newOrderCount,
    repeatOrderCount,
    repeatSharePercent:
      revenue === 0 ? 0 : Math.round((repeatRevenuePence / revenue) * 100),
  };
}

export function topProductsByRevenue(
  periodFacts: PaidOrderFact[],
  items: LineItemRow[],
  limit = 10,
): TopProductRow[] {
  const netByOrder = new Map(periodFacts.map((row) => [row.orderId, row]));
  const grouped = new Map<string, TopProductRow>();

  for (const item of items) {
    const order = netByOrder.get(item.orderId);
    if (!order) continue;
    const scale =
      order.totalPence > 0 ? order.netPence / order.totalPence : 0;
    const revenuePence = Math.round(
      item.quantity * item.unitPricePence * scale,
    );
    const key = item.productId ?? `name:${item.productName}`;
    const current = grouped.get(key) ?? {
      productId: item.productId,
      name: item.productName,
      revenuePence: 0,
      quantity: 0,
    };
    current.revenuePence += revenuePence;
    current.quantity += item.quantity;
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .sort(
      (a, b) =>
        b.revenuePence - a.revenuePence ||
        b.quantity - a.quantity ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

export type LiveAnalytics = {
  range: AnalyticsRange;
  current: PeriodTotals;
  previous: PeriodTotals;
  aovPence: number;
  revenueChange: number | null;
  revenueChangeLabel: string;
  buckets: AnalyticsBucket[];
  split: NewVsRepeatSplit;
  currentFacts: PaidOrderFact[];
};

export function summarizeLiveAnalytics(
  facts: PaidOrderFact[],
  range: AnalyticsRange,
  now = new Date(),
): LiveAnalytics {
  const currentWindow_ = currentWindow(range, now);
  const previousWindow_ = previousWindow(range, currentWindow_);
  const currentFacts = facts.filter((row) => inWindow(row.paidAt, currentWindow_));
  const previousFacts = facts.filter((row) =>
    inWindow(row.paidAt, previousWindow_),
  );
  const current = totalsFor(currentFacts);
  const previous = totalsFor(previousFacts);
  const change = percentChange(current.revenuePence, previous.revenuePence);

  const earliest = facts[0]?.paidAt ?? currentWindow_.start.toISOString();
  const keys = iterateBucketKeys(range, earliest, now);
  const byKey = new Map<string, PaidOrderFact[]>();
  for (const fact of facts) {
    const key = bucketKey(range, fact.paidAt);
    const list = byKey.get(key) ?? [];
    list.push(fact);
    byKey.set(key, list);
  }

  const buckets: AnalyticsBucket[] = keys
    .map((key) => {
      const totals = totalsFor(byKey.get(key) ?? []);
      return {
        key,
        label: formatBucketLabel(range, key),
        orderCount: totals.orderCount,
        revenuePence: totals.revenuePence,
      };
    })
    .reverse();

  return {
    range,
    current,
    previous,
    aovPence: averageOrderValue(current),
    revenueChange: change,
    revenueChangeLabel: formatPercentChange(change),
    buckets,
    split: newVsRepeatSplit(currentFacts, facts),
    currentFacts,
  };
}
