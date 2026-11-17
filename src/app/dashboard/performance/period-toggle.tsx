"use client";

import Link from "next/link";

import {
  PERFORMANCE_PERIODS,
  type PerformancePeriodDays,
} from "@/lib/analytics/performance-periods";
import { performanceCopy, type PerformanceLang } from "@/lib/analytics/performance-copy";
import { cn } from "@/lib/utils";

export function PerformancePeriodToggle({
  days,
  lang,
}: {
  days: PerformancePeriodDays;
  lang: PerformanceLang;
}) {
  const copy = performanceCopy(lang);
  return (
    <div
      role="tablist"
      aria-label={copy.periodLabel}
      className="inline-flex max-w-full overflow-x-auto rounded-lg border bg-muted/30 p-0.5"
    >
      {PERFORMANCE_PERIODS.map((id) => {
        const active = days === id;
        return (
          <Link
            key={id}
            href={`/dashboard/performance?days=${id}`}
            role="tab"
            aria-selected={active}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {copy.period[id]}
          </Link>
        );
      })}
    </div>
  );
}
