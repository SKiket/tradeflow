export const CUSTOMER_SEGMENTS = ["all", "new", "repeat", "lapsed"] as const;

export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_WITHIN_DAYS = 30;
const LAPSED_AFTER_DAYS = 60;

export type CustomerSegmentFields = {
  order_count: number;
  last_order_at: string | null;
};

export function parseCustomerSegment(value: string | undefined): CustomerSegment {
  if (value === "new" || value === "repeat" || value === "lapsed") return value;
  return "all";
}

export function customerMatchesSegment(
  customer: CustomerSegmentFields,
  segment: CustomerSegment,
  now = new Date(),
): boolean {
  if (segment === "all") return true;

  const last = customer.last_order_at
    ? new Date(customer.last_order_at).getTime()
    : null;
  const ageMs = last == null ? null : now.getTime() - last;

  if (segment === "new") {
    return (
      customer.order_count === 1 &&
      ageMs != null &&
      ageMs <= NEW_WITHIN_DAYS * DAY_MS
    );
  }

  if (segment === "repeat") {
    return customer.order_count > 1;
  }

  return ageMs != null && ageMs > LAPSED_AFTER_DAYS * DAY_MS;
}

export function parseTagInput(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of value.split(",")) {
    const tag = part.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

export function formatTagInput(tags: string[] | null | undefined): string {
  return (tags ?? []).join(", ");
}
