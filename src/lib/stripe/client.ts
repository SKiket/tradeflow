import Stripe from "stripe";

let cached: Stripe | null = null;

/**
 * Lazily-instantiated Stripe client (server-only).
 *
 * TradeFlow uses its own dedicated Stripe account — separate from the
 * Marketing Platform — so a multi-tenant Connect platform never shares an
 * account with unrelated first-party billing.
 */
export function getStripe(): Stripe {
  if (cached) return cached;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  cached = new Stripe(secretKey, {
    // Pin the API version the integration was written against so Stripe
    // account-level upgrades never silently change behaviour.
    apiVersion: "2026-06-24.dahlia",
    appInfo: { name: "TradeFlow" },
  });
  return cached;
}
