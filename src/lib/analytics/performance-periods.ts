import { utcDayStart, type UtcWindow } from "@/lib/analytics/ranges";

export const PERFORMANCE_PERIODS = [7, 30, 90] as const;

export type PerformancePeriodDays = (typeof PERFORMANCE_PERIODS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export function parsePerformancePeriod(
  value: string | undefined,
): PerformancePeriodDays {
  const n = Number.parseInt(value ?? "", 10);
  if (n === 7 || n === 30 || n === 90) return n;
  return 30;
}

/** Rolling window of `days` ending at end-of-today UTC (exclusive end = tomorrow 00:00). */
export function rollingWindow(
  days: PerformancePeriodDays,
  now = new Date(),
): UtcWindow {
  const end = new Date(utcDayStart(now).getTime() + DAY_MS);
  const start = new Date(end.getTime() - days * DAY_MS);
  return { start, end };
}

export function previousRollingWindow(current: UtcWindow): UtcWindow {
  const lengthMs = current.end.getTime() - current.start.getTime();
  return {
    start: new Date(current.start.getTime() - lengthMs),
    end: current.start,
  };
}

/** Inclusive UTC day keys YYYY-MM-DD for every day in [start, end). */
export function iterateDayKeys(window: UtcWindow): string[] {
  const keys: string[] = [];
  let cursor = utcDayStart(window.start);
  const endMs = window.end.getTime();
  while (cursor.getTime() < endMs) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return keys;
}

export function formatDayLabel(key: string, lang: "en" | "fr"): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * Change vs prior period. Never returns a percentage when the base is zero.
 * null ⇒ "no previous data".
 */
export function changeVersusPrior(
  current: number,
  previous: number,
): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
