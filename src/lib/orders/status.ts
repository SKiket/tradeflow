/** Order status values used by TradeFlow. */
export const ORDER_STATUS = {
  /** Default legacy status from schema — not used by draft confirmation flow. */
  PENDING: "PENDING",
  /** Draft awaiting buyer YES; created/updated by createDraftOrderFromParse. */
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
  /** Buyer confirmed; stock reserved; Stripe Checkout link sent. */
  AWAITING_PAYMENT: "AWAITING_PAYMENT",
  /** Payment received; stock permanently decremented; reservation released. */
  PAID: "PAID",
  /** Seller marked the order dispatched (post-payment fulfilment). */
  DISPATCHED: "DISPATCHED",
  /** Seller marked the order delivered to the buyer. */
  DELIVERED: "DELIVERED",
  /** Refund initiated; awaiting Stripe refund.updated confirmation. */
  REFUND_PENDING: "REFUND_PENDING",
  /** Fully refunded (cumulative refunded_amount_pence === total_pence). */
  REFUNDED: "REFUNDED",
  /** Partially refunded; further refunds may be possible. */
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  /** Buyer declined or draft abandoned before payment. */
  CANCELLED: "CANCELLED",
  /** Reservation expired (lazy sweep or checkout.session.expired). */
  EXPIRED: "EXPIRED",
  /** Payment failed (payment_intent.payment_failed / async_payment_failed). */
  PAYMENT_FAILED: "PAYMENT_FAILED",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/** Statuses from which a refund may be initiated (payment must have succeeded). */
export const REFUNDABLE_STATUSES = [
  ORDER_STATUS.PAID,
  ORDER_STATUS.DISPATCHED,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.PARTIALLY_REFUNDED,
] as const;
