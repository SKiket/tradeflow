export const DEFAULT_RETURN_WINDOW_DAYS = 14;

export const RETURN_WINDOW_BELOW_STATUTORY_WARNING =
  "UK law requires a minimum 14-day cooling-off period for most online orders — check with a solicitor before setting this lower.";

export function parseReturnWindowDays(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_RETURN_WINDOW_DAYS;
  return Math.trunc(n);
}

/** True when deliveredAt is not in the future and elapsed time is within windowDays. */
export function isWithinReturnWindow(
  deliveredAt: Date,
  windowDays: number,
  now = new Date(),
): boolean {
  const days = Number.isFinite(windowDays)
    ? windowDays
    : DEFAULT_RETURN_WINDOW_DAYS;
  const elapsedMs = now.getTime() - deliveredAt.getTime();
  return elapsedMs >= 0 && elapsedMs <= days * 24 * 60 * 60 * 1000;
}
