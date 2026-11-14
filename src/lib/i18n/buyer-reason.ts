import { t } from "@/lib/i18n";
import {
  parseReturnReason,
  type ReturnReason,
} from "@/lib/orders/return-reasons";

/** Stripe RefundCreateParams.reason values — never show these to buyers. */
const STRIPE_REFUND_REASON_CODES = new Set([
  "requested_by_customer",
  "duplicate",
  "fraudulent",
]);

/**
 * Buyer-facing label for a structured return reason.
 * For "other", prefer the buyer's own detail text unchanged.
 */
export function buyerFacingReturnReasonLabel(
  reason: ReturnReason,
  detail: string | null | undefined,
  lang: string | null | undefined,
): string {
  if (reason === "other" && detail?.trim()) {
    return detail.trim();
  }
  return t(`return_reason.${reason}`, lang);
}

/**
 * Resolve a refund ledger / free-text reason for buyer WhatsApp.
 * Returns null when the Reason line must be omitted (Stripe codes, empty,
 * or anything that would expose "fraudulent").
 */
export function buyerFacingRefundReasonDisplay(
  reason: string | null | undefined,
  lang: string | null | undefined,
): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  // Stripe codes — including "fraudulent" — must never reach a buyer.
  if (STRIPE_REFUND_REASON_CODES.has(lower)) {
    return null;
  }

  const parsed = parseReturnReason(trimmed);
  if (parsed) {
    return t(`return_reason.${parsed}`, lang);
  }

  // Seller free text — show unchanged.
  return trimmed;
}
