import type Stripe from "stripe";

import { getStripe } from "@/lib/stripe/client";

export const SELLER_SUBSCRIPTION_TRIAL_DAYS = 30;

export {
  PLATFORM_FEE_RATE,
  SHOP_UNAVAILABLE_BUYER_MESSAGE,
  SHOP_UNAVAILABLE_STOREFRONT_DETAIL,
  SHOP_UNAVAILABLE_STOREFRONT_HEADLINE,
  SUBSCRIPTION_STATUSES,
  canAcceptOrders,
  isSellerSubscriptionStatus,
  ordersPausedBanner,
  platformApplicationFeePence,
  trialEndsAtFromUnix,
} from "@/lib/stripe/billing-gate";
export type {
  OrdersPausedBanner,
  SellerSubscriptionStatus,
} from "@/lib/stripe/billing-gate";

function subscriptionPriceId(): string {
  const id = process.env.STRIPE_SUBSCRIPTION_PRICE_ID?.trim();
  if (!id) {
    throw new Error("STRIPE_SUBSCRIPTION_PRICE_ID is not configured");
  }
  return id;
}

function appBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

export async function getOrCreateSellerCustomer(params: {
  businessId: string;
  existingCustomerId?: string | null;
  email?: string | null;
  name?: string | null;
}): Promise<Stripe.Customer> {
  const stripe = getStripe();
  if (params.existingCustomerId) {
    const existing = await stripe.customers.retrieve(params.existingCustomerId);
    if (!existing.deleted) return existing;
  }

  return stripe.customers.create({
    email: params.email ?? undefined,
    name: params.name ?? undefined,
    metadata: { tradeflow_business_id: params.businessId },
  });
}

export async function createSellerSubscriptionCheckout(params: {
  customerId: string;
  businessId: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<Stripe.Checkout.Session> {
  const base = appBaseUrl();
  return getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: params.customerId,
    line_items: [{ price: subscriptionPriceId(), quantity: 1 }],
    payment_method_collection: "always",
    subscription_data: {
      trial_period_days: SELLER_SUBSCRIPTION_TRIAL_DAYS,
      metadata: { tradeflow_business_id: params.businessId },
    },
    metadata: {
      tradeflow_business_id: params.businessId,
      purpose: "seller-subscription",
    },
    success_url:
      params.successUrl ??
      `${base}/dashboard/settings?billing=success`,
    cancel_url:
      params.cancelUrl ?? `${base}/dashboard/settings?billing=cancelled`,
  });
}

export async function createSellerBillingPortalSession(params: {
  customerId: string;
  returnUrl?: string;
}): Promise<Stripe.BillingPortal.Session> {
  const base = appBaseUrl();
  return getStripe().billingPortal.sessions.create({
    customer: params.customerId,
    return_url: params.returnUrl ?? `${base}/dashboard/settings`,
  });
}

export type SellerBillingCopy = {
  headline: string;
  detail: string;
  action: "start_trial" | "manage" | "none";
};

export function sellerBillingStatus(params: {
  customerId: string | null;
  status: string | null;
  trialEndsAt: string | null;
}): SellerBillingCopy {
  const status = params.status;
  const trialEndsAt = params.trialEndsAt;

  if (!params.customerId && !status) {
    return {
      headline: "Billing: Not set up",
      detail:
        "No TradeFlow subscription yet. Start a 30-day trial — card required, nothing charged until it ends.",
      action: "start_trial",
    };
  }

  if (status === "trialing") {
    const days = trialDaysRemaining(trialEndsAt);
    const headline =
      days === null
        ? "Trial active"
        : days === 0
          ? "Trial ends today"
          : days === 1
            ? "Trial ends in 1 day"
            : `Trial ends in ${days} days`;
    return {
      headline,
      detail:
        "The £10/month plan and the 1% per-order fee are both waived until the trial ends.",
      action: "manage",
    };
  }

  if (status === "active") {
    return {
      headline: "Active — £10/month + 1% per order",
      detail: "Your TradeFlow subscription is current.",
      action: "manage",
    };
  }

  if (status === "past_due" || status === "unpaid") {
    return {
      headline: "Payment failed — update your card",
      detail:
        "The last invoice did not succeed. Update your card in the billing portal.",
      action: "manage",
    };
  }

  if (status === "canceled") {
    return {
      headline: "Subscription canceled",
      detail: "You can start a new trial or subscription from here.",
      action: "start_trial",
    };
  }

  if (status === "incomplete" || status === "incomplete_expired") {
    return {
      headline: "Billing setup incomplete",
      detail: "Finish checkout to start your trial. Card is required.",
      action: "start_trial",
    };
  }

  return {
    headline: params.customerId ? "Billing on file" : "Billing: Not set up",
    detail: status
      ? `Stripe status: ${status}.`
      : "No TradeFlow subscription yet.",
    action: params.customerId ? "manage" : "start_trial",
  };
}

function trialDaysRemaining(trialEndsAt: string | null): number | null {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
}
