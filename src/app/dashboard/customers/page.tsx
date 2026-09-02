import { Users } from "lucide-react";
import Link from "next/link";

import {
  priorPeriodLabel,
  RangeToggle,
  thisPeriodLabel,
} from "@/components/dashboard/range-toggle";
import { fetchPaidOrderFacts } from "@/lib/analytics/paid-orders";
import { parseAnalyticsRange } from "@/lib/analytics/ranges";
import { summarizeLiveAnalytics } from "@/lib/analytics/summarize";
import {
  compareCustomersByRecentActivity,
  EMPTY_CUSTOMER_LIFETIME,
  lifetimeByCustomerId,
} from "@/lib/customers/lifetime";
import {
  customerMatchesSegment,
  LAPSED_AFTER_DAYS,
  parseCustomerSegment,
} from "@/lib/customers/segments";
import { formatPence } from "@/lib/orders/display";

import { requireSeller } from "../require-seller";

import { CustomersTable, type CustomerListRow } from "./customers-table";

function parseCustomerSort(value: string | undefined): "recent" | "lifetime" {
  return value === "lifetime" ? "lifetime" : "recent";
}

function compareByLifetime(a: CustomerListRow, b: CustomerListRow): number {
  if (a.lifetime_value_pence !== b.lifetime_value_pence) {
    return b.lifetime_value_pence - a.lifetime_value_pence;
  }
  if (a.order_count !== b.order_count) return b.order_count - a.order_count;
  return compareCustomersByRecentActivity(a, b);
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ segment?: string; range?: string; sort?: string }>;
}) {
  const { segment: segmentParam, range: rangeParam, sort: sortParam } =
    await searchParams;
  const initialSegment = parseCustomerSegment(segmentParam);
  const range = parseAnalyticsRange(rangeParam);
  const sort = parseCustomerSort(sortParam);
  const { supabase, businessId } = await requireSeller();

  const [
    { data, error },
    { data: orderRows, error: ordersError },
    { facts, error: factsError },
  ] = await Promise.all([
    supabase
      .from("customers")
      .select("id, name, phone_e164, tags, created_at")
      .eq("business_id", businessId),
    supabase
      .from("orders")
      .select("customer_id, status, total_pence, refunded_amount_pence, created_at")
      .eq("business_id", businessId),
    fetchPaidOrderFacts(supabase, businessId),
  ]);

  if (error || ordersError || factsError) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Customers</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load customers.{" "}
          {(error ?? ordersError)?.message ?? factsError}
        </p>
      </div>
    );
  }

  const lifetime = lifetimeByCustomerId(
    (orderRows ?? []).map((row) => ({
      customer_id: (row.customer_id as string | null) ?? null,
      status: row.status as string,
      total_pence: (row.total_pence as number) ?? 0,
      refunded_amount_pence: (row.refunded_amount_pence as number | null) ?? 0,
      created_at: row.created_at as string,
    })),
  );

  const customers: CustomerListRow[] = (data ?? []).map((row) => {
    const stats = lifetime.get(row.id as string) ?? EMPTY_CUSTOMER_LIFETIME;
    return {
      id: row.id as string,
      name: (row.name as string | null) ?? null,
      phone_e164: row.phone_e164 as string,
      order_count: stats.order_count,
      lifetime_value_pence: stats.lifetime_value_pence,
      last_order_at: stats.last_order_at,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      created_at: (row.created_at as string | null) ?? null,
    };
  });

  const listed =
    sort === "lifetime"
      ? [...customers].sort(compareByLifetime)
      : [...customers].sort(compareCustomersByRecentActivity);

  const topCustomers = [...customers]
    .filter((row) => row.lifetime_value_pence > 0)
    .sort(compareByLifetime)
    .slice(0, 10);

  const lapsedCount = customers.filter((row) =>
    customerMatchesSegment(row, "lapsed"),
  ).length;
  const summary = summarizeLiveAnalytics(facts, range);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="tf-page-heading">Customers</h1>
        <p className="text-sm text-muted-foreground">
          {customers.length === 0
            ? "Buyers will appear here after they message you or place an order."
            : `${customers.length} customer${customers.length === 1 ? "" : "s"}.`}
        </p>
      </div>

      {customers.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-16 text-center">
          <Users className="size-10 text-muted-foreground" />
          <h2 className="mt-4 text-lg font-semibold">No customers yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            When someone messages your shop or checks out, they&apos;ll show up
            here with their order history.
          </p>
        </div>
      ) : (
        <>
          {lapsedCount > 0 ? (
            <Link
              href="/dashboard/customers?segment=lapsed"
              className="block rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 hover:bg-amber-100"
            >
              {`${lapsedCount} customer${lapsedCount === 1 ? "" : "s"} haven't ordered in ${LAPSED_AFTER_DAYS}+ days`}
            </Link>
          ) : (
            <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
              {`Lapsed: 0 customers beyond ${LAPSED_AFTER_DAYS} days.`}
            </p>
          )}

          <section className="space-y-3 rounded-xl border px-4 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold">
                  New vs repeat revenue · {thisPeriodLabel(range)}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {summary.current.revenuePence === 0
                    ? "No paid orders in this period."
                    : `${summary.split.repeatSharePercent}% of revenue from repeat customers (${formatPence(summary.split.repeatRevenuePence)} of ${formatPence(summary.current.revenuePence)}).`}
                </p>
              </div>
              <RangeToggle
                range={range}
                basePath="/dashboard/customers"
                extraParams={{ sort, segment: initialSegment }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              New {formatPence(summary.split.newRevenuePence)} · Repeat{" "}
              {formatPence(summary.split.repeatRevenuePence)} · vs{" "}
              {priorPeriodLabel(range)}
            </p>
          </section>

          {topCustomers.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Top customers by lifetime value
              </h2>
              <ol className="overflow-hidden rounded-xl border">
                {topCustomers.map((customer, index) => (
                  <li
                    key={customer.id}
                    className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0"
                  >
                    <Link
                      href={`/dashboard/customers/${customer.id}`}
                      className="min-w-0 font-medium hover:underline"
                    >
                      <span className="mr-2 text-xs tabular-nums text-muted-foreground">
                        {index + 1}.
                      </span>
                      {customer.name || customer.phone_e164}
                    </Link>
                    <span className="shrink-0 text-sm tabular-nums">
                      {formatPence(customer.lifetime_value_pence)}
                      <span className="ml-2 text-muted-foreground">
                        {`${customer.order_count} order${customer.order_count === 1 ? "" : "s"}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Link
              href={`/dashboard/customers?sort=recent&range=${range}&segment=${initialSegment}`}
              className={
                sort === "recent"
                  ? "rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
                  : "rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
              }
            >
              Recent activity
            </Link>
            <Link
              href={`/dashboard/customers?sort=lifetime&range=${range}&segment=${initialSegment}`}
              className={
                sort === "lifetime"
                  ? "rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
                  : "rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
              }
            >
              Highest lifetime value
            </Link>
          </div>

          <CustomersTable
            customers={listed}
            initialSegment={initialSegment}
          />
        </>
      )}
    </div>
  );
}
