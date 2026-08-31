export const AI_PAUSE_MS = 24 * 60 * 60 * 1000;

export function pauseAiUntil(from: Date = new Date()): Date {
  return new Date(from.getTime() + AI_PAUSE_MS);
}

export function isAiPaused(
  until: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!until) return false;
  const ms = Date.parse(until);
  if (Number.isNaN(ms)) return false;
  return ms > now.getTime();
}

export function isAiPausedSkip(parse: unknown): boolean {
  if (!parse || typeof parse !== "object") return false;
  const row = parse as Record<string, unknown>;
  return row.skipped === true && row.reason === "ai_paused";
}

export const AI_PAUSED_PARSE = {
  skipped: true,
  reason: "ai_paused",
} as const;
