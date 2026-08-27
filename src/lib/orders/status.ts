/** Order status values used by TradeFlow. */
export const ORDER_STATUS = {
  /** Default legacy status from schema — not used by draft confirmation flow. */
  PENDING: "PENDING",
  /** Draft awaiting buyer YES; created/updated by createDraftOrderFromParse. */
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
