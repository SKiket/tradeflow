/** Hours before evidence_due_by when we auto-submit the staged pack. */
export const DISPUTE_AUTO_SUBMIT_HOURS_BEFORE = 24;

/**
 * Minimum disputed amount (pence) for auto-submit. Below this we only remind.
 * Override with DISPUTE_AUTO_SUBMIT_MIN_PENCE.
 */
export function getDisputeAutoSubmitMinPence(): number {
  const raw = process.env.DISPUTE_AUTO_SUBMIT_MIN_PENCE;
  if (raw != null && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 4000;
}

/** Reminder offsets (days before deadline). Each fires once per dispute. */
export const DISPUTE_REMINDER_DAYS = [5, 2, 1] as const;

function envPence(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw != null && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * UK Stripe dispute-received fee (pence). Never returned outside Mexico.
 * Override: DISPUTE_RECEIVED_FEE_PENCE, or legacy DISPUTE_FEE_PENCE.
 */
export function getDisputeReceivedFeePence(): number {
  const received = process.env.DISPUTE_RECEIVED_FEE_PENCE;
  if (received != null && received !== "") {
    return envPence("DISPUTE_RECEIVED_FEE_PENCE", 2000);
  }
  // Legacy alias
  return envPence("DISPUTE_FEE_PENCE", 2000);
}

/**
 * UK Stripe dispute-countered fee (pence). Charged when evidence is submitted;
 * returned by Stripe only if the dispute is won. We recover it from the seller
 * only when contested and lost.
 */
export function getDisputeCounterFeePence(): number {
  return envPence("DISPUTE_COUNTER_FEE_PENCE", 2000);
}

/**
 * @deprecated Use getDisputeReceivedFeePence(). Kept as fallback alias.
 */
export function getDisputeFeePence(): number {
  return getDisputeReceivedFeePence();
}

/** @deprecated Prefer getDisputeReceivedFeePence(). */
export const DISPUTE_FEE_PENCE = 2000;
export const DISPUTE_RECEIVED_FEE_PENCE = 2000;
export const DISPUTE_COUNTER_FEE_PENCE = 2000;
export const DISPUTE_AUTO_SUBMIT_MIN_PENCE = 4000;

export type DisputeEvidenceStatus =
  | "draft"
  | "ready"
  | "submitted"
  | "not_needed";

export type DisputeOutcome = "won" | "lost";

export type DisputeSubmittedBy = "seller" | "auto";

export type DisputeRecoveryStatus =
  | "not_needed"
  | "pending"
  | "recovered"
  | "partial"
  | "unpaid";

export type DisputeFeeSource = "stripe_balance_transactions" | "constants";

/**
 * Seller fee liability once a dispute closes.
 *
 * Decision (comment also in recover.ts):
 * - Accepted (lost, not contested): received fee only (+ unrecovered amount).
 * - Contested and lost: received + counter fees (+ unrecovered amount).
 * - Contested and won, or withdrawn: seller owes £0 — Copalla absorbs the
 *   received fee (and Stripe returns the counter fee on a win).
 */
export function sellerFeeLiabilityPence(params: {
  contested: boolean;
  outcome: DisputeOutcome | null;
  receivedFeePence: number;
  counterFeePence: number;
}): number {
  if (params.outcome !== "lost") return 0;
  if (params.contested) {
    return (
      Math.max(0, params.receivedFeePence) + Math.max(0, params.counterFeePence)
    );
  }
  return Math.max(0, params.receivedFeePence);
}

/** Stripe statuses that mean the dispute is still open / actionable. */
export const OPEN_DISPUTE_STATUSES = [
  "warning_needs_response",
  "warning_under_review",
  "needs_response",
  "under_review",
  "appeal_needs_response",
  "appeal_under_review",
] as const;

/** Stripe statuses that mean the dispute is closed. */
export const CLOSED_DISPUTE_STATUSES = [
  "won",
  "lost",
  "warning_closed",
  "prevented",
] as const;

export function isOpenDisputeStatus(status: string): boolean {
  return (OPEN_DISPUTE_STATUSES as readonly string[]).includes(status);
}

export function outcomeFromStripeStatus(
  status: string,
): DisputeOutcome | null {
  if (status === "won") return "won";
  if (status === "lost") return "lost";
  // Inquiry closed without chargeback — treat as won (no recovery).
  if (status === "warning_closed" || status === "prevented") return "won";
  return null;
}

/** Plain-English dispute reasons for seller UI. */
export const DISPUTE_REASON_LABELS: Record<string, string> = {
  bank_cannot_process: "Bank could not process the payment",
  check_returned: "Cheque returned",
  credit_not_processed: "Credit or refund not processed",
  customer_initiated: "Customer initiated",
  debit_not_authorized: "Debit not authorised",
  duplicate: "Duplicate charge",
  fraudulent: "Fraudulent",
  general: "General",
  incorrect_account_details: "Incorrect account details",
  insufficient_funds: "Insufficient funds",
  noncompliant: "Non-compliant",
  product_not_received: "Product not received",
  product_unacceptable: "Product unacceptable",
  subscription_canceled: "Subscription cancelled",
  unrecognized: "Unrecognised charge",
};

export function disputeReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Unknown reason";
  return DISPUTE_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}
