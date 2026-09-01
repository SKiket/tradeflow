export const ANALYTICS_RANGES = ["day", "week", "month", "year"] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export function parseAnalyticsRange(
  value: string | undefined,
): AnalyticsRange {
  if (value === "day" || value === "week" || value === "month" || value === "year") {
    return value;
  }
  return "month";
}

export type UtcWindow = {
  start: Date;
  end: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Monday 00:00 UTC of the ISO week containing `date`. */
export function utcWeekStart(date: Date): Date {
  const start = utcDayStart(date);
  const weekday = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - (weekday - 1));
  return start;
}

export function utcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function utcYearStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

export function currentWindow(range: AnalyticsRange, now = new Date()): UtcWindow {
  if (range === "day") {
    const start = utcDayStart(now);
    return { start, end: new Date(start.getTime() + DAY_MS) };
  }
  if (range === "week") {
    const start = utcWeekStart(now);
    return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
  }
  if (range === "month") {
    const start = utcMonthStart(now);
    return {
      start,
      end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
    };
  }
  const start = utcYearStart(now);
  return {
    start,
    end: new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1)),
  };
}

export function previousWindow(range: AnalyticsRange, current: UtcWindow): UtcWindow {
  if (range === "day") {
    return {
      start: new Date(current.start.getTime() - DAY_MS),
      end: current.start,
    };
  }
  if (range === "week") {
    return {
      start: new Date(current.start.getTime() - 7 * DAY_MS),
      end: current.start,
    };
  }
  if (range === "month") {
    const start = new Date(
      Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 1, 1),
    );
    return { start, end: current.start };
  }
  const start = new Date(Date.UTC(current.start.getUTCFullYear() - 1, 0, 1));
  return { start, end: current.start };
}

export function inWindow(iso: string, window: UtcWindow): boolean {
  const t = new Date(iso).getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}

export function bucketKey(range: AnalyticsRange, iso: string): string {
  const date = new Date(iso);
  if (range === "day") return date.toISOString().slice(0, 10);
  if (range === "month") {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (range === "year") return String(date.getUTCFullYear());
  return isoWeekKey(date);
}

function isoWeekKey(date: Date): string {
  const utc = utcDayStart(date);
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function nextBucketStart(range: AnalyticsRange, start: Date): Date {
  if (range === "day") return new Date(start.getTime() + DAY_MS);
  if (range === "week") return new Date(start.getTime() + 7 * DAY_MS);
  if (range === "month") {
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
  return new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1));
}

function alignStart(range: AnalyticsRange, date: Date): Date {
  if (range === "day") return utcDayStart(date);
  if (range === "week") return utcWeekStart(date);
  if (range === "month") return utcMonthStart(date);
  return utcYearStart(date);
}

/** Inclusive bucket keys from the first paid moment through `now`. */
export function iterateBucketKeys(
  range: AnalyticsRange,
  fromIso: string,
  now = new Date(),
): string[] {
  const keys: string[] = [];
  let cursor = alignStart(range, new Date(fromIso));
  const last = alignStart(range, now);
  while (cursor.getTime() <= last.getTime()) {
    keys.push(bucketKey(range, cursor.toISOString()));
    cursor = nextBucketStart(range, cursor);
  }
  return keys;
}

export function formatBucketLabel(range: AnalyticsRange, key: string): string {
  if (range === "day") {
    const [year, month, day] = key.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }
  if (range === "week") {
    const [yearPart, weekPart] = key.split("-W");
    return `Week ${Number(weekPart)}, ${yearPart}`;
  }
  if (range === "month") {
    const [year, month] = key.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    }).format(new Date(Date.UTC(year, month - 1, 1)));
  }
  return key;
}

export function rangeNoun(range: AnalyticsRange): string {
  return range;
}

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function formatPercentChange(value: number | null): string {
  if (value == null) return "No prior period";
  if (value === 0) return "0% vs prior";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}% vs prior`;
}
