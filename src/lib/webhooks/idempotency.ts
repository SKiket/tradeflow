const WINDOW_MS = 5 * 60 * 1000;

interface Entry {
  firstSeenAt: number;
  count: number;
}

const seen = new Map<string, Entry>();

function prune(now: number) {
  for (const [key, entry] of seen) {
    if (now - entry.firstSeenAt > WINDOW_MS) {
      seen.delete(key);
    }
  }
}

export function checkIdempotency(
  source: string,
  key: string,
): { isDuplicate: boolean; count: number } {
  const now = Date.now();
  prune(now);

  const composite = `${source}:${key}`;
  const existing = seen.get(composite);

  if (existing) {
    existing.count += 1;
    console.warn(
      `[webhook-idempotency] Duplicate key "${key}" for source "${source}" (count=${existing.count})`,
    );
    return { isDuplicate: true, count: existing.count };
  }

  seen.set(composite, { firstSeenAt: now, count: 1 });
  return { isDuplicate: false, count: 1 };
}

/** Test helper — reset in-memory store between runs. */
export function resetIdempotencyStore() {
  seen.clear();
}
