/** Reserved UK test numbers (Ofcom 07700 900xxx) — never burn Twilio quota. */
const TEST_NUMBER_RE = /^\+447700900\d{3}$/;

export type DeliveryStatus =
  | "sent"
  | "failed"
  | "simulated"
  | "superseded"
  | "expired"
  | "failed_processing";

export type DeliveryAudience = "buyer" | "seller";

/** Context stamped on outbound rows so retries can validate freshness. */
export type RetryContext =
  | {
      kind: "draft_confirmation";
      orderId: string;
      orderRef: string;
      totalPence: number;
      /** Stable signature of item lines: variantId:qty:unitPrice,… */
      itemSignature: string;
    }
  | {
      kind: "payment_link";
      orderId: string;
    }
  | {
      kind: "generic";
    };

/** State-dependent replies are recovered via pending_replay, not text retry. */
export function isStateDependentRetryContext(
  ctx: RetryContext | null | undefined,
): boolean {
  return ctx?.kind === "draft_confirmation" || ctx?.kind === "payment_link";
}

export const RETRY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const APOLOGY_COOLDOWN_MS = 10 * 60 * 1000;

export function isReservedTestNumber(phoneE164: string): boolean {
  return TEST_NUMBER_RE.test(phoneE164.trim());
}

export function shouldSkipRealTwilioSend(phoneE164: string): boolean {
  if (process.env.FORCE_REAL_SEND === "true") return false;
  return isReservedTestNumber(phoneE164);
}

/** Transient / retryable Twilio failures (rate limit, server errors). */
export function isRetryableTwilioFailure(params: {
  twilioCode?: number | string | null;
  twilioStatus?: number | null;
}): boolean {
  const code = Number(params.twilioCode);
  if (code === 63038) return true;
  if (params.twilioStatus === 429) return true;
  if (
    typeof params.twilioStatus === "number" &&
    params.twilioStatus >= 500 &&
    params.twilioStatus < 600
  ) {
    return true;
  }
  return false;
}

export function isRateLimitFailure(params: {
  twilioCode?: number | string | null;
  twilioStatus?: number | null;
}): boolean {
  const code = Number(params.twilioCode);
  return code === 63038 || params.twilioStatus === 429;
}

/** Max send attempts including the first. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Backoff in minutes before the next retry.
 * Rate-limit: 30 → 120 → stop (day window exhausted after hard cap).
 * Other transient: 5 → 15 → 60.
 */
export function retryBackoffMinutes(params: {
  attemptJustFinished: number;
  rateLimited: boolean;
}): number | null {
  const nextAttempt = params.attemptJustFinished + 1;
  if (nextAttempt > MAX_DELIVERY_ATTEMPTS) return null;
  if (params.rateLimited) {
    const schedule = [30, 120, 360];
    return schedule[params.attemptJustFinished - 1] ?? null;
  }
  const schedule = [5, 15, 60];
  return schedule[params.attemptJustFinished - 1] ?? null;
}

export function plainDeliveryReason(params: {
  errorCode?: string | number | null;
  errorMessage?: string | null;
}): string {
  const code = String(params.errorCode ?? "");
  const msg = (params.errorMessage ?? "").trim();
  if (code === "63038" || /daily messages limit/i.test(msg)) {
    return "Daily message limit reached";
  }
  if (code === "outside_window_no_template") {
    return "WhatsApp window closed — no approved template";
  }
  if (code === "63016" || /outside.*window|freeform/i.test(msg)) {
    return "WhatsApp messaging window closed";
  }
  if (code === "63015") {
    return "Message could not be delivered";
  }
  if (/429|too many requests/i.test(msg)) {
    return "Rate limited — will retry later";
  }
  if (msg) {
    return msg.length > 120 ? `${msg.slice(0, 117)}…` : msg;
  }
  if (code) return `Delivery failed (${code})`;
  return "Delivery failed";
}

export function nextRetryAtIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function buildDraftItemSignature(
  items: Array<{
    product_variant_id: string;
    quantity: number;
    unit_price_pence: number;
  }>,
): string {
  return [...items]
    .map(
      (i) =>
        `${i.product_variant_id}:${i.quantity}:${i.unit_price_pence}`,
    )
    .sort()
    .join(",");
}

export function parseRetryContext(
  raw: Record<string, unknown> | null | undefined,
): RetryContext | null {
  const ctx = raw?.retry_context;
  if (!ctx || typeof ctx !== "object") return null;
  const row = ctx as Record<string, unknown>;
  if (row.kind === "draft_confirmation") {
    if (
      typeof row.orderId === "string" &&
      typeof row.orderRef === "string" &&
      typeof row.totalPence === "number" &&
      typeof row.itemSignature === "string"
    ) {
      return {
        kind: "draft_confirmation",
        orderId: row.orderId,
        orderRef: row.orderRef,
        totalPence: row.totalPence,
        itemSignature: row.itemSignature,
      };
    }
  }
  if (row.kind === "payment_link" && typeof row.orderId === "string") {
    return { kind: "payment_link", orderId: row.orderId };
  }
  if (row.kind === "generic") return { kind: "generic" };
  return null;
}
