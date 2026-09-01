import Link from "next/link";

import {
  ANALYTICS_RANGES,
  rangeNoun,
  type AnalyticsRange,
} from "@/lib/analytics/ranges";
import { cn } from "@/lib/utils";

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
};

export function RangeToggle({
  range,
  basePath,
  extraParams,
}: {
  range: AnalyticsRange;
  basePath: string;
  extraParams?: Record<string, string>;
}) {
  return (
    <div
      role="tablist"
      aria-label="Period"
      className="inline-flex rounded-lg border bg-muted/30 p-0.5"
    >
      {ANALYTICS_RANGES.map((id) => {
        const params = new URLSearchParams({ ...extraParams, range: id });
        const active = range === id;
        return (
          <Link
            key={id}
            href={`${basePath}?${params.toString()}`}
            role="tab"
            aria-selected={active}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {RANGE_LABEL[id]}
          </Link>
        );
      })}
    </div>
  );
}

export function thisPeriodLabel(range: AnalyticsRange): string {
  if (range === "day") return "Today";
  return `This ${rangeNoun(range)}`;
}

export function priorPeriodLabel(range: AnalyticsRange): string {
  if (range === "day") return "yesterday";
  return `last ${rangeNoun(range)}`;
}
