import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

export type PricingConfig = {
  id: string;
  effectiveFrom: string;
  monthlyFeePence: number;
  orderFeeBps: number;
  orderFeeFixedPence: number;
  trialDays: number;
  chargeOrderFeeDuringTrial: boolean;
};

const CACHE_TTL_MS = 60_000;

type CacheEntry = {
  expiresAt: number;
  value: PricingConfig;
};

let cache: CacheEntry | null = null;

/** Round half up for non-negative numbers (JS Math.round does this for positives). */
function roundHalfUp(n: number): number {
  return Math.round(n);
}

/**
 * Pure: Connect application fee for an order total.
 * fee = round-half-up(amount * bps / 10000) + fixed, clamped to [0, amount].
 */
export function computeApplicationFee(
  amountPence: number,
  pricing: Pick<PricingConfig, "orderFeeBps" | "orderFeeFixedPence">,
): number {
  if (!Number.isFinite(amountPence) || amountPence <= 0) return 0;
  const amount = Math.floor(amountPence);
  const pct = roundHalfUp((amount * pricing.orderFeeBps) / 10_000);
  const fee = pct + Math.max(0, pricing.orderFeeFixedPence);
  if (fee <= 0) return 0;
  return Math.min(amount, fee);
}

export function formatPricingMoney(pence: number): string {
  return `£${(Math.max(0, pence) / 100).toFixed(2)}`;
}

/** Seller-facing short plan summary from config. */
export function pricingPlanSummary(pricing: PricingConfig): string {
  const monthly = formatPricingMoney(pricing.monthlyFeePence);
  const pct = (pricing.orderFeeBps / 100).toFixed(
    pricing.orderFeeBps % 100 === 0 ? 0 : 1,
  );
  const fixed = formatPricingMoney(pricing.orderFeeFixedPence);
  return `${monthly}/month + ${pct}% + ${fixed} per order`;
}

function rowToPricing(row: {
  id: string;
  effective_from: string;
  monthly_fee_pence: number;
  order_fee_bps: number;
  order_fee_fixed_pence: number;
  trial_days: number;
  charge_order_fee_during_trial: boolean;
}): PricingConfig {
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    monthlyFeePence: row.monthly_fee_pence,
    orderFeeBps: row.order_fee_bps,
    orderFeeFixedPence: row.order_fee_fixed_pence,
    trialDays: row.trial_days,
    chargeOrderFeeDuringTrial: row.charge_order_fee_during_trial,
  };
}

/**
 * Latest pricing row with effective_from <= now.
 * Cached briefly in-process (service role).
 */
export async function getActivePricing(
  supabase: SupabaseClient = createAdminClient(),
  options?: { bypassCache?: boolean },
): Promise<PricingConfig> {
  const now = Date.now();
  if (!options?.bypassCache && cache && cache.expiresAt > now) {
    return cache.value;
  }

  const { data, error } = await supabase
    .from("pricing_config")
    .select(
      "id, effective_from, monthly_fee_pence, order_fee_bps, order_fee_fixed_pence, trial_days, charge_order_fee_during_trial",
    )
    .lte("effective_from", new Date().toISOString())
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`getActivePricing failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("getActivePricing failed: no pricing_config row");
  }

  const value = rowToPricing(
    data as {
      id: string;
      effective_from: string;
      monthly_fee_pence: number;
      order_fee_bps: number;
      order_fee_fixed_pence: number;
      trial_days: number;
      charge_order_fee_during_trial: boolean;
    },
  );
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Test helper — clear in-process cache. */
export function clearPricingCache(): void {
  cache = null;
}

/**
 * Application fee for a TradeFlow checkout, honouring trial + config.
 * Returns 0 when fee should not be charged (caller may omit Stripe field).
 */
export function applicationFeeForCheckout(params: {
  amountPence: number;
  pricing: PricingConfig;
  subscriptionStatus?: string | null;
}): number {
  const duringTrial = params.subscriptionStatus === "trialing";
  if (duringTrial && !params.pricing.chargeOrderFeeDuringTrial) {
    return 0;
  }
  return computeApplicationFee(params.amountPence, params.pricing);
}
