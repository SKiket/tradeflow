/** Order status values used by TradeFlow. */
export const ORDER_STATUS = {
  /** Default legacy status from schema — not used by draft confirmation flow. */
  PENDING: "PENDING",
  /** Draft awaiting buyer YES; created/updated by createDraftOrderFromParse. */
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
  /** Buyer confirmed; stock reserved; Stripe Checkout link sent. */
  AWAITING_PAYMENT: "AWAITING_PAYMENT",
  /** Buyer declined or draft abandoned before payment. */
  CANCELLED: "CANCELLED",
  /** Reservation expired (lazy sweep or checkout.session.expired). */
  EXPIRED: "EXPIRED",
  /** Payment failed (payment_intent.payment_failed). */
  PAYMENT_FAILED: "PAYMENT_FAILED",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
