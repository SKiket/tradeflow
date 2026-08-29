import type { SupabaseClient } from "@supabase/supabase-js";

/** Trailing UTC days the hourly job rewrites (today + previous 2) so late
 *  refund.updated webhooks correct recent days. Dashboard reads 14 days. */
export const ANALYTICS_RECOMPUTE_DAYS = 3;
export const ANALYTICS_DASHBOARD_DAYS = 14;

export interface AnalyticsRunResult {
  businesses: number;
  days: number;
  rowsUpserted: number;
}

function utcPeriodKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayStart(daysAgo: number, from = new Date()): Date {
  return new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate() - daysAgo,
    ),
  );
}

/**
 * Recompute analytics_cache for each business over the last N UTC days
 * (today + previous 2 by default) so late refund.updated webhooks correct
 * yesterday/the-day-before. Revenue is net of refunded_amount_pence.
 *
 * order_count keys off the transition INTO PAID in order_status_history,
 * not orders.created_at or current status (a later refund must not drop
 * the order from that day's count).
 */
export async function runAnalyticsAggregate(
  supabase: SupabaseClient,
  days = ANALYTICS_RECOMPUTE_DAYS,
): Promise<AnalyticsRunResult> {
  const { data: businesses, error: bizError } = await supabase
    .from("businesses")
    .select("id")
    .is("deleted_at", null);
  if (bizError) {
    throw new Error(`analytics business lookup failed: ${bizError.message}`);
  }

  const windowStart = utcDayStart(days - 1);
  const windowEnd = utcDayStart(-1); // tomorrow 00:00 UTC
  const periods = Array.from({ length: days }, (_, i) =>
    utcPeriodKey(utcDayStart(i)),
  );

  const { data: history, error: histError } = await supabase
    .from("order_status_history")
    .select("order_id, business_id, changed_at")
    .eq("to_status", "PAID")
    .gte("changed_at", windowStart.toISOString())
    .lt("changed_at", windowEnd.toISOString())
    .order("changed_at", { ascending: true });
  if (histError) {
    throw new Error(`analytics PAID-history lookup failed: ${histError.message}`);
  }

  const firstPaid = new Map<
    string,
    { businessId: string; period: string }
  >();
  for (const row of history ?? []) {
    const orderId = row.order_id as string;
    if (firstPaid.has(orderId)) continue;
    firstPaid.set(orderId, {
      businessId: row.business_id as string,
      period: utcPeriodKey(new Date(row.changed_at as string)),
    });
  }

  const orderIds = [...firstPaid.keys()];
  const amounts = new Map<string, { total: number; refunded: number }>();
  if (orderIds.length) {
    const { data: orders, error: orderError } = await supabase
      .from("orders")
      .select("id, total_pence, refunded_amount_pence")
      .in("id", orderIds)
      .is("deleted_at", null);
    if (orderError) {
      throw new Error(`analytics order lookup failed: ${orderError.message}`);
    }
    for (const order of orders ?? []) {
      amounts.set(order.id as string, {
        total: (order.total_pence as number) ?? 0,
        refunded: (order.refunded_amount_pence as number) ?? 0,
      });
    }
  }

  const buckets = new Map<string, { orderCount: number; revenuePence: number }>();
  for (const [orderId, meta] of firstPaid) {
    const amount = amounts.get(orderId);
    if (!amount) continue;
    const key = `${meta.businessId}|${meta.period}`;
    const current = buckets.get(key) ?? { orderCount: 0, revenuePence: 0 };
    current.orderCount += 1;
    current.revenuePence += Math.max(0, amount.total - amount.refunded);
    buckets.set(key, current);
  }

  const now = new Date().toISOString();
  const rows: Array<{
    business_id: string;
    period: string;
    order_count: number;
    revenue_pence: number;
    computed_at: string;
    deleted_at: null;
  }> = [];

  for (const business of businesses ?? []) {
    const businessId = business.id as string;
    for (const period of periods) {
      const bucket = buckets.get(`${businessId}|${period}`) ?? {
        orderCount: 0,
        revenuePence: 0,
      };
      rows.push({
        business_id: businessId,
        period,
        order_count: bucket.orderCount,
        revenue_pence: bucket.revenuePence,
        computed_at: now,
        deleted_at: null,
      });
    }
  }

  if (rows.length) {
    const { error: upsertError } = await supabase.from("analytics_cache").upsert(
      rows,
      { onConflict: "business_id,period" },
    );
    if (upsertError) {
      throw new Error(`analytics_cache upsert failed: ${upsertError.message}`);
    }
  }

  console.info("[analytics] aggregate complete", {
    businesses: businesses?.length ?? 0,
    days,
    rows: rows.length,
  });

  return {
    businesses: businesses?.length ?? 0,
    days,
    rowsUpserted: rows.length,
  };
}
