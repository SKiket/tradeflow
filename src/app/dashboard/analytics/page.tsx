import { ANALYTICS_DASHBOARD_DAYS } from "@/lib/cron/analytics-aggregate";
import { formatPence } from "@/lib/orders/display";

import { requireSeller } from "../require-seller";

function utcPeriodKey(daysAgo: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysAgo,
    ),
  )
    .toISOString()
    .slice(0, 10);
}

function formatPeriod(period: string): string {
  const [year, month, day] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export default async function AnalyticsPage() {
  const { supabase, businessId } = await requireSeller();
  const periods = Array.from({ length: ANALYTICS_DASHBOARD_DAYS }, (_, i) =>
    utcPeriodKey(i),
  );
  const oldest = periods[periods.length - 1];

  const { data, error } = await supabase
    .from("analytics_cache")
    .select("period, revenue_pence, order_count")
    .eq("business_id", businessId)
    .gte("period", oldest)
    .is("deleted_at", null);

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load analytics. {error.message}
        </p>
      </div>
    );
  }

  const byPeriod = new Map(
    (data ?? []).map((row) => [
      row.period as string,
      {
        revenue_pence: (row.revenue_pence as number) ?? 0,
        order_count: (row.order_count as number) ?? 0,
      },
    ]),
  );

  const rows = periods.map((period) => {
    const cached = byPeriod.get(period);
    return {
      period,
      order_count: cached?.order_count ?? 0,
      revenue_pence: cached?.revenue_pence ?? 0,
    };
  });

  const totalOrders = rows.reduce((sum, row) => sum + row.order_count, 0);
  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue_pence, 0);
  const averageRevenue = Math.round(totalRevenue / ANALYTICS_DASHBOARD_DAYS);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Last {ANALYTICS_DASHBOARD_DAYS} days (UTC), net of refunds.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Day</th>
              <th className="px-4 py-3 text-right">Orders</th>
              <th className="px-4 py-3 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.period} className="border-b last:border-b-0">
                <td className="px-4 py-3">
                  <span className="font-medium">{formatPeriod(row.period)}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {row.period}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.order_count}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatPence(row.revenue_pence)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t bg-muted/40 text-sm">
            <tr>
              <td className="px-4 py-3 font-medium">
                {ANALYTICS_DASHBOARD_DAYS}-day total
                <span className="ml-2 font-normal text-muted-foreground">
                  (avg {formatPence(averageRevenue)}/day)
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium">
                {totalOrders}
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium">
                {formatPence(totalRevenue)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
