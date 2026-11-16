/**
 * Pure billing-status helpers. Safe to import from client components.
 * Stripe API calls live in billing.ts — do not import getStripe here.
 */

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
] as const;

export type SellerSubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSellerSubscriptionStatus(
  value: unknown,
): value is SellerSubscriptionStatus {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

export type AcceptOrdersBlockReason =
  | "shop_closed"
  | "billing_inactive"
  | "dispute_balance_unpaid";

/**
 * Why new orders are blocked, or null when allowed.
 * dispute_balance_unpaid: lost-dispute recovery invoice unpaid (Step 21b).
 */
export function getAcceptOrdersBlockReason(business: {
  stripe_subscription_status?: string | null;
  closed_at?: string | null;
  dispute_balance_hold?: boolean | null;
} | null | undefined): AcceptOrdersBlockReason | null {
  if (business?.closed_at) return "shop_closed";
  if (business?.dispute_balance_hold) return "dispute_balance_unpaid";
  const status = business?.stripe_subscription_status;
  if (status === "trialing" || status === "active") return null;
  return "billing_inactive";
}

/**
 * Binary gate for NEW order creation. Only an active trial or paid
 * subscription may take new storefront / WhatsApp orders. Closed shops
 * (seller-initiated closure) never accept new orders. Unpaid dispute
 * recovery also blocks (reason dispute_balance_unpaid).
 */
export function canAcceptOrders(business: {
  stripe_subscription_status?: string | null;
  closed_at?: string | null;
  dispute_balance_hold?: boolean | null;
} | null | undefined): boolean {
  return getAcceptOrdersBlockReason(business) === null;
}

/** English default — prefer t("billing.shop_unavailable", lang) at send sites. */
export const SHOP_UNAVAILABLE_BUYER_MESSAGE =
  "This shop isn't currently taking new orders. If you already have an order with us, we'll still fulfil it. Please try again later.";

export const SHOP_UNAVAILABLE_STOREFRONT_HEADLINE =
  "This shop isn't currently taking orders";

export const SHOP_UNAVAILABLE_STOREFRONT_DETAIL =
  "New orders are paused while the seller updates their TradeFlow billing. Existing orders will still be fulfilled.";

/** Seller closed the shop (grace or tombstone). Prefer t("billing.shop_closed", lang). */
export const SHOP_CLOSED_STOREFRONT_HEADLINE = "This shop has closed";

export const SHOP_CLOSED_STOREFRONT_DETAIL =
  "This shop is no longer selling on TradeFlow.";

export type OrdersPausedBanner = {
  title: string;
  body: string;
};

/**
 * Seller-facing copy for the dashboard banner. Uses the synced Stripe
 * status — trial ended, payment failed, or canceled — not a generic line.
 */
export function ordersPausedBanner(params: {
  status: string | null;
  trialEndsAt: string | null;
  blockReason?: AcceptOrdersBlockReason | null;
  disputeOwedPence?: number | null;
}): OrdersPausedBanner {
  if (params.blockReason === "dispute_balance_unpaid") {
    const owed =
      typeof params.disputeOwedPence === "number" && params.disputeOwedPence > 0
        ? `£${(params.disputeOwedPence / 100).toFixed(2)}`
        : "an unpaid amount";
    return {
      title: "Your shop is not accepting new orders",
      body: `You owe ${owed} from a lost dispute. Update your card or pay to resume.`,
    };
  }

  const status = params.status;
  const trialEnded =
    Boolean(params.trialEndsAt) &&
    new Date(params.trialEndsAt as string).getTime() <= Date.now();

  if (status === "past_due" || status === "unpaid") {
    return {
      title: "Your shop is not accepting new orders",
      body: "Payment failed — update your card in Manage billing. Existing orders can still be dispatched, delivered, and refunded.",
    };
  }

  if (status === "canceled" && trialEnded) {
    return {
      title: "Your shop is not accepting new orders",
      body: "Your trial has ended. Restart billing from Manage billing to take new orders. Existing paid orders are unaffected.",
    };
  }

  if (status === "canceled") {
    return {
      title: "Your shop is not accepting new orders",
      body: "Your subscription is canceled. Restart billing from Manage billing to take new orders. Existing paid orders are unaffected.",
    };
  }

  if (status === "incomplete" || status === "incomplete_expired") {
    return {
      title: "Your shop is not accepting new orders",
      body: "Billing setup is incomplete. Finish checkout from Manage billing to take new orders.",
    };
  }

  if (trialEnded && status !== "trialing" && status !== "active") {
    return {
      title: "Your shop is not accepting new orders",
      body: "Your trial has ended. Update billing from Manage billing to take new orders. Existing paid orders are unaffected.",
    };
  }

  return {
    title: "Your shop is not accepting new orders",
    body: "TradeFlow billing is not active. Open Manage billing to fix this. Existing paid orders are unaffected.",
  };
}

export function trialEndsAtFromUnix(trialEnd: number | null | undefined): string | null {
  if (!trialEnd || trialEnd <= 0) return null;
  return new Date(trialEnd * 1000).toISOString();
}

/**
 * @deprecated Prefer getActivePricing() + computeApplicationFee().
 * Synchronous stub kept for import compatibility; checkout uses async pricing.
 */
export function platformApplicationFeePence(
  _totalPence: number,
  _subscriptionStatus: string | null | undefined,
): number | undefined {
  return undefined;
}
