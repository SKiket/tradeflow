import type Stripe from "stripe";

import { getActivePricing } from "@/lib/pricing/config";
import { getStripe } from "@/lib/stripe/client";

/** Fallback when pricing_config is unreachable — prefer getActivePricing().trialDays. */
export const SELLER_SUBSCRIPTION_TRIAL_DAYS = 30;

export {
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
  let trialDays = SELLER_SUBSCRIPTION_TRIAL_DAYS;
  try {
    const pricing = await getActivePricing();
    trialDays = pricing.trialDays;
  } catch (error) {
    console.warn("[billing] pricing_config unavailable for trial days", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: params.customerId,
    line_items: [{ price: subscriptionPriceId(), quantity: 1 }],
    payment_method_collection: "always",
    subscription_data: {
      trial_period_days: trialDays,
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
  /** Optional live pricing; when omitted, copy uses safe defaults. */
  pricingSummary?: string | null;
  monthlyFeePence?: number | null;
  orderFeeDuringTrial?: boolean | null;
  trialDays?: number | null;
}): SellerBillingCopy {
  const status = params.status;
  const trialEndsAt = params.trialEndsAt;
  const plan =
    params.pricingSummary?.trim() ||
    "£19.00/month + 4.5% + £0.20 per order";
  const trialDays = params.trialDays ?? SELLER_SUBSCRIPTION_TRIAL_DAYS;
  const orderFeeInTrial = params.orderFeeDuringTrial !== false;

  if (!params.customerId && !status) {
    return {
      headline: "Billing: Not set up",
      detail: `No TradeFlow subscription yet. Start a ${trialDays}-day trial — card required, monthly fee not charged until it ends.${
        orderFeeInTrial
          ? " Per-order fees still apply on card/Pay by Bank sales during the trial."
          : ""
      }`,
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
      detail: orderFeeInTrial
        ? `Monthly subscription fee waived until the trial ends. Per-order fees still apply on card and Pay by Bank sales (${plan}).`
        : `Monthly subscription and per-order fees are waived until the trial ends. After trial: ${plan}.`,
      action: "manage",
    };
  }

  if (status === "active") {
    return {
      headline: `Active — ${plan}`,
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
