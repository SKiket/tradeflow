import * as Sentry from "@sentry/nextjs";

/** Readable Sentry issue title for unmatched Stripe disputes. */
export const UNMATCHED_DISPUTE_ORDER_MESSAGE =
  "Stripe dispute could not be matched to an order";

export type UnmatchedDisputeOrderDeps = {
  captureMessage: typeof Sentry.captureMessage;
  warn: (...args: unknown[]) => void;
};

const defaultDeps: UnmatchedDisputeOrderDeps = {
  captureMessage: Sentry.captureMessage.bind(Sentry),
  warn: (...args: unknown[]) => {
    console.warn(...args);
  },
};

/**
 * Report a dispute that could not be linked to an order.
 * Live mode → Sentry warning (readable title). Test mode → server log only.
 * No personal data.
 */
export function reportUnmatchedDisputeOrder(
  input: {
    livemode: boolean | null | undefined;
    stripeDisputeId: string;
    hasChargeId: boolean;
    hasPaymentIntent: boolean;
  },
  deps: UnmatchedDisputeOrderDeps = defaultDeps,
): "sentry" | "log" {
  const detail = { stripeDisputeId: input.stripeDisputeId };

  if (input.livemode !== true) {
    deps.warn(`[disputes] ${UNMATCHED_DISPUTE_ORDER_MESSAGE}`, detail);
    return "log";
  }

  deps.captureMessage(UNMATCHED_DISPUTE_ORDER_MESSAGE, {
    level: "warning",
    tags: {
      stripe_dispute_id: input.stripeDisputeId,
      event: "dispute_unmatched_order",
    },
    fingerprint: ["dispute_unmatched_order", input.stripeDisputeId],
    extra: {
      has_charge_id: input.hasChargeId,
      has_payment_intent: input.hasPaymentIntent,
    },
  });
  return "sentry";
}
