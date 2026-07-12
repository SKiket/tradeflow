import type Stripe from "stripe";

import { getStripe } from "@/lib/stripe/client";

/**
 * Create a Stripe Express connected account for a seller.
 *
 * Express accounts use Stripe's hosted onboarding, so TradeFlow never
 * captures raw bank details — Stripe collects and verifies them directly.
 */
export async function createExpressConnectedAccount(params: {
  businessId: string;
  email?: string;
}): Promise<Stripe.Account> {
  return getStripe().accounts.create({
    type: "express",
    country: "GB",
    email: params.email,
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { tradeflow_business_id: params.businessId },
  });
}

/**
 * Create a hosted account-onboarding link for a connected account.
 *
 * `refresh_url` is used by Stripe if the link expires before completion;
 * `return_url` is where the seller lands once onboarding finishes.
 */
export async function createAccountOnboardingLink(params: {
  connectedAccountId: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<string> {
  const link = await getStripe().accountLinks.create({
    account: params.connectedAccountId,
    refresh_url: params.refreshUrl,
    return_url: params.returnUrl,
    type: "account_onboarding",
  });
  return link.url;
}
