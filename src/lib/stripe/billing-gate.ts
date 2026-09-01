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

/**
 * Binary gate for NEW order creation. Only an active trial or paid
 * subscription may take new storefront / WhatsApp orders.
 */
export function canAcceptOrders(business: {
  stripe_subscription_status?: string | null;
} | null | undefined): boolean {
  const status = business?.stripe_subscription_status;
  return status === "trialing" || status === "active";
}

export const SHOP_UNAVAILABLE_BUYER_MESSAGE =
  "This shop isn't currently taking new orders. If you already have an order with us, we'll still fulfil it. Please try again later.";

export const SHOP_UNAVAILABLE_STOREFRONT_HEADLINE =
  "This shop isn't currently taking orders";

export const SHOP_UNAVAILABLE_STOREFRONT_DETAIL =
  "New orders are paused while the seller updates their TradeFlow billing. Existing orders will still be fulfilled.";

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
}): OrdersPausedBanner {
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

export const PLATFORM_FEE_RATE = 0.01;

export function platformApplicationFeePence(
  totalPence: number,
  subscriptionStatus: string | null | undefined,
): number | undefined {
  if (subscriptionStatus === "trialing") return undefined;
  if (!Number.isFinite(totalPence) || totalPence <= 0) return undefined;
  const fee = Math.round(totalPence * PLATFORM_FEE_RATE);
  return fee > 0 ? fee : undefined;
}
