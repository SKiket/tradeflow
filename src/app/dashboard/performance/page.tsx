import { getBusinessSellerLanguage } from "@/lib/channels/templates/business-language";
import {
  fetchPaidOrderFacts,
  fetchPaidOrderItems,
} from "@/lib/analytics/paid-orders";
import {
  formatChangeLabel,
  performanceCopy,
  resolvePerformanceLang,
} from "@/lib/analytics/performance-copy";
import {
  parsePerformancePeriod,
  rollingWindow,
} from "@/lib/analytics/performance-periods";
import {
  summarizePerformance,
  type StatusBucketKey,
} from "@/lib/analytics/performance-summarize";
import { formatPence } from "@/lib/orders/display";
import { ORDER_STATUS } from "@/lib/orders/status";
import { cn } from "@/lib/utils";

import { requireSeller } from "../require-seller";
import { PerformancePeriodToggle } from "./period-toggle";

const STATUS_ORDER: StatusBucketKey[] = [
  "paid",
  "dispatched",
  "delivered",
  "cancelled",
  "refunded",
];

export default async function PerformancePage({
  searchParams,
}: {
  searchParams?: Promise<{ days?: string }>;
}) {
  const { supabase, businessId } = await requireSeller();
  const params = searchParams ? await searchParams : {};
  const days = parsePerformancePeriod(params.days);

  const [{ facts, error }, sellerLang] = await Promise.all([
    fetchPaidOrderFacts(supabase, businessId),
    getBusinessSellerLanguage(supabase, businessId),
  ]);
  const lang = resolvePerformanceLang(sellerLang);
  const copy = performanceCopy(lang);

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">{copy.title}</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load performance. {error}
        </p>
      </div>
    );
  }

  const window = rollingWindow(days);
  const paidIds = new Set(
    facts
      .filter((f) => {
        const t = new Date(f.paidAt).getTime();
        return t >= window.start.getTime() && t < window.end.getTime();
      })
      .map((f) => f.orderId),
  );

  const { data: cancelledRows } = await supabase
    .from("orders")
    .select("id")
    .eq("business_id", businessId)
    .eq("status", ORDER_STATUS.CANCELLED)
    .is("deleted_at", null)
    .gte("created_at", window.start.toISOString())
    .lt("created_at", window.end.toISOString());

  const cancelledUnpaid = (cancelledRows ?? []).filter(
    (row) => !paidIds.has(row.id as string),
  ).length;

  const periodPaidIds = [...paidIds];
  const { items } = await fetchPaidOrderItems(
    supabase,
    businessId,
    periodPaidIds,
  );
  const summary = summarizePerformance(
    facts,
    items,
    days,
    cancelledUnpaid,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="tf-page-heading">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
        <PerformancePeriodToggle days={days} lang={lang} />
      </div>

      {summary.empty ? (
        <section
          className="rounded-xl border border-border/80 bg-muted/20 px-4 py-8 text-center"
          data-tf-performance="empty"
        >
          <p className="text-base font-semibold text-foreground">{copy.empty}</p>
          <p className="mt-1 text-sm text-muted-foreground">{copy.emptyBody}</p>
        </section>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard
              label={copy.sales}
              value={formatPence(summary.sales.value)}
              change={summary.sales.changePercent}
              lang={lang}
            />
            <MetricCard
              label={copy.orders}
              value={String(summary.orders.value)}
              change={summary.orders.changePercent}
              lang={lang}
            />
            <MetricCard
              label={copy.aov}
              value={formatPence(summary.aov.value)}
              change={summary.aov.changePercent}
              lang={lang}
            />
            <MetricCard
              label={copy.refunds}
              value={formatPence(summary.refundAmountPence.value)}
              hint={
                summary.refundCount.value === 0
                  ? undefined
                  : copy.refundDetail(
                      formatPence(summary.refundAmountPence.value),
                      summary.refundCount.value,
                    )
              }
              change={summary.refundAmountPence.changePercent}
              lang={lang}
            />
            <MetricCard
              label={copy.returns}
              value={String(summary.returnCount.value)}
              hint={copy.returnDetail(summary.returnCount.value)}
              change={summary.returnCount.changePercent}
              lang={lang}
            />
          </div>

          <section className="space-y-2" data-tf-performance="status">
            <h2 className="text-sm font-semibold tracking-tight">
              {copy.statusTitle}
            </h2>
            <ul className="divide-y divide-border rounded-xl border">
              {STATUS_ORDER.map((key) => (
                <li
                  key={key}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="text-muted-foreground">{copy.status[key]}</span>
                  <span className="font-medium tabular-nums">
                    {summary.statusCounts[key]}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2" data-tf-performance="top">
            <h2 className="text-sm font-semibold tracking-tight">
              {copy.topTitle}
            </h2>
            {summary.topProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{copy.empty}</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border">
                {summary.topProducts.map((row) => (
                  <li
                    key={row.productId ?? row.name}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                    data-tf-performance-product={row.name}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {row.name}
                    </span>
                    <span className="shrink-0 text-right text-muted-foreground">
                      {copy.topUnits(row.units)}
                      <span className="mx-1.5 text-border">·</span>
                      <span className="font-medium text-foreground tabular-nums">
                        {formatPence(row.salesPence)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3" data-tf-performance="daily">
            <h2 className="text-sm font-semibold tracking-tight">
              {copy.dailyTitle}
            </h2>
            <DailyBars daily={summary.daily} lang={lang} />
          </section>

          <section className="space-y-2" data-tf-performance="channel">
            <h2 className="text-sm font-semibold tracking-tight">
              {copy.channelTitle}
            </h2>
            <ul className="divide-y divide-border rounded-xl border">
              <ChannelRow
                label={copy.whatsapp}
                count={summary.channel.whatsappCount}
                percent={summary.channel.whatsappPercent}
              />
              <ChannelRow
                label={copy.storefront}
                count={summary.channel.storefrontCount}
                percent={summary.channel.storefrontPercent}
              />
              {summary.channel.otherCount > 0 ? (
                <ChannelRow
                  label={copy.other}
                  count={summary.channel.otherCount}
                  percent={
                    summary.channel.total === 0
                      ? null
                      : Math.round(
                          (summary.channel.otherCount / summary.channel.total) *
                            1000,
                        ) / 10
                  }
                />
              ) : null}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  change,
  lang,
}: {
  label: string;
  value: string;
  hint?: string;
  change: number | null;
  lang: "en" | "fr";
}) {
  const formatted = formatChangeLabel(change, lang);
  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
      <p
        className={cn(
          "mt-1 text-xs font-medium",
          formatted.direction === "up" && "text-emerald-700",
          formatted.direction === "down" && "text-rose-700",
          (formatted.direction === "flat" || formatted.direction === "none") &&
            "text-muted-foreground",
        )}
      >
        {formatted.text}
      </p>
    </div>
  );
}

function ChannelRow({
  label,
  count,
  percent,
}: {
  label: string;
  count: number;
  percent: number | null;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">
        {count}
        {percent != null ? (
          <span className="ml-2 text-muted-foreground">({percent}%)</span>
        ) : null}
      </span>
    </li>
  );
}

function DailyBars({
  daily,
  lang,
}: {
  daily: { key: string; salesPence: number; orderCount: number }[];
  lang: "en" | "fr";
}) {
  const max = Math.max(1, ...daily.map((d) => d.salesPence));
  // Show at most ~14 labels on mobile by sampling when many days.
  const labelEvery = daily.length > 14 ? Math.ceil(daily.length / 7) : 1;

  return (
    <div className="rounded-xl border px-3 py-4">
      <div className="flex h-36 items-end gap-0.5 sm:gap-1">
        {daily.map((day) => {
          const heightPct = Math.round((day.salesPence / max) * 100);
          return (
            <div
              key={day.key}
              className="flex min-w-0 flex-1 flex-col items-center justify-end"
              title={`${day.key}: ${formatPence(day.salesPence)}`}
            >
              <div
                className="w-full max-w-[14px] rounded-t bg-foreground/80"
                style={{ height: `${Math.max(day.salesPence > 0 ? 4 : 0, heightPct)}%` }}
                data-tf-performance-day={day.key}
                data-tf-performance-day-pence={day.salesPence}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-0.5 sm:gap-1">
        {daily.map((day, index) => (
          <div
            key={`lbl-${day.key}`}
            className="min-w-0 flex-1 text-center text-[9px] leading-tight text-muted-foreground sm:text-[10px]"
          >
            {index % labelEvery === 0 || index === daily.length - 1
              ? formatDayShort(day.key, lang)
              : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDayShort(key: string, lang: "en" | "fr"): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
