export const RETURN_REASONS = [
  "wrong_size",
  "damaged_faulty",
  "changed_mind",
  "not_as_described",
  "arrived_late",
  "other",
] as const;

export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  wrong_size: "wrong size",
  damaged_faulty: "item arrived damaged",
  changed_mind: "changed mind",
  not_as_described: "not as described",
  arrived_late: "arrived late",
  other: "other",
};

export function isReturnReason(value: string | null | undefined): value is ReturnReason {
  return (
    typeof value === "string" &&
    (RETURN_REASONS as readonly string[]).includes(value)
  );
}

export function parseReturnReason(value: unknown): ReturnReason | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isReturnReason(trimmed) ? trimmed : null;
}
