import type { ReactNode } from "react";
import Link from "next/link";

import {
  priorPeriodLabel,
  RangeToggle,
  thisPeriodLabel,
} from "@/components/dashboard/range-toggle";
import { fetchPaidOrderFacts, fetchPaidOrderItems } from "@/lib/analytics/paid-orders";
import { parseAnalyticsRange } from "@/lib/analytics/ranges";
import { summarizeLiveAnalytics, topProductsByRevenue } from "@/lib/analytics/summarize";
import {
  EMPTY_CUSTOMER_LIFETIME,
  lifetimeByCustomerId,
} from "@/lib/customers/lifetime";
import {
  customerMatchesSegment,
  LAPSED_AFTER_DAYS,
} from "@/lib/customers/segments";
import { formatPence } from "@/lib/orders/display";

import { requireSeller } from "../require-seller";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range = parseAnalyticsRange(rangeParam);
  const { supabase, businessId } = await requireSeller();

  const [{ facts, error }, { data: customerRows }] = await Promise.all([
    fetchPaidOrderFacts(supabase, businessId),
    supabase.from("customers").select("id, created_at").eq("business_id", businessId),
  ]);

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Analytics</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load analytics. {error}
        </p>
      </div>
    );
  }

  const summary = summarizeLiveAnalytics(facts, range);
  const { items, error: itemsError } = await fetchPaidOrderItems(
    supabase,
    businessId,
    summary.currentFacts.map((row) => row.orderId),
  );
  const topProducts = topProductsByRevenue(summary.currentFacts, items);

  const { data: orderRows } = await supabase
    .from("orders")
    .select("customer_id, status, total_pence, refunded_amount_pence, created_at")
    .eq("business_id", businessId);
  const lifetime = lifetimeByCustomerId(
    (orderRows ?? []).map((row) => ({
      customer_id: (row.customer_id as string | null) ?? null,
      status: row.status as string,
      total_pence: (row.total_pence as number) ?? 0,
      refunded_amount_pence: (row.refunded_amount_pence as number | null) ?? 0,
      created_at: row.created_at as string,
    })),
  );
  const lapsedCount = (customerRows ?? []).filter((row) => {
    const stats = lifetime.get(row.id as string) ?? EMPTY_CUSTOMER_LIFETIME;
    return customerMatchesSegment(stats, "lapsed");
  }).length;

  const up = (summary.revenueChange ?? 0) > 0;
  const down = (summary.revenueChange ?? 0) < 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="tf-page-heading">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Live from paid orders, net of refunds. Not the 3-day cache.
          </p>
        </div>
        <RangeToggle range={range} basePath="/dashboard/analytics" />
      </div>

      {lapsedCount > 0 ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <Link
            href="/dashboard/customers?segment=lapsed"
            className="font-medium underline-offset-4 hover:underline"
          >
            {`${lapsedCount} customer${lapsedCount === 1 ? "" : "s"} haven't ordered in ${LAPSED_AFTER_DAYS}+ days`}
          </Link>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {`Lapsed: 0 customers beyond ${LAPSED_AFTER_DAYS} days.`}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={`${thisPeriodLabel(range)} revenue`}
          value={formatPence(summary.current.revenuePence)}
          hint={
            <span
              className={
                up
                  ? "text-emerald-700"
                  : down
                    ? "text-rose-700"
                    : "text-muted-foreground"
              }
            >
              {summary.revenueChangeLabel} ({priorPeriodLabel(range)})
            </span>
          }
        />
        <StatCard
          label="Orders"
          value={String(summary.current.orderCount)}
          hint={`Prior ${priorPeriodLabel(range)}: ${summary.previous.orderCount}`}
        />
        <StatCard
          label="Average order value"
          value={formatPence(summary.aovPence)}
          hint="Net revenue / orders this period"
        />
        <StatCard
          label="Repeat revenue"
          value={`${summary.split.repeatSharePercent}%`}
          hint={`${formatPence(summary.split.repeatRevenuePence)} from returning buyers`}
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Revenue by {range}
        </h2>
        {summary.buckets.length === 0 ? (
          <p className="rounded-xl border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            No paid orders yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3 text-right">Orders</th>
                  <th className="px-4 py-3 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {summary.buckets.map((row) => (
                  <tr key={row.key} className="border-b last:border-b-0">
                    <td className="px-4 py-3">
                      <span className="font-medium">{row.label}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {row.key}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.orderCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatPence(row.revenuePence)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Top products by revenue
        </h2>
        {itemsError ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t load products. {itemsError}
          </p>
        ) : topProducts.length === 0 ? (
          <p className="rounded-xl border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            No product sales in this period.
          </p>
        ) : (
          <ol className="overflow-hidden rounded-xl border">
            {topProducts.map((product, index) => (
              <li
                key={product.productId ?? product.name}
                className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="mr-2 text-xs tabular-nums text-muted-foreground">
                    {index + 1}.
                  </span>
                  <span className="font-medium">{product.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {product.quantity} sold
                  </span>
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  {formatPence(product.revenuePence)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: ReactNode;
}) {
  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
