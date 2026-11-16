/** Hours before evidence_due_by when we auto-submit the staged pack. */
export const DISPUTE_AUTO_SUBMIT_HOURS_BEFORE = 24;

/** Reminder offsets (days before deadline). Each fires once per dispute. */
export const DISPUTE_REMINDER_DAYS = [5, 2, 1] as const;

export type DisputeEvidenceStatus =
  | "draft"
  | "ready"
  | "submitted"
  | "not_needed";

export type DisputeOutcome = "won" | "lost";

export type DisputeSubmittedBy = "seller" | "auto";

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
