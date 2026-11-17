/**
 * Pure helpers for Stripe Connect payment readiness (destination charges).
 * Destination Checkout needs charges_enabled AND transfers capability active.
 */

export type ConnectCapabilitySnapshot = {
  stripe_charges_enabled?: boolean | null;
  stripe_transfers_capability_active?: boolean | null;
  stripe_details_submitted?: boolean | null;
  stripe_connected_account_id?: string | null;
};

/**
 * True when the connected account can receive destination charges / transfers.
 * Independent of TradeFlow subscription billing (canAcceptOrders).
 */
export function canTakeCardPayments(
  business: ConnectCapabilitySnapshot | null | undefined,
): boolean {
  if (!business?.stripe_connected_account_id) return false;
  return (
    Boolean(business.stripe_charges_enabled) &&
    Boolean(business.stripe_transfers_capability_active)
  );
}

export function transfersCapabilityActiveFromAccount(account: {
  capabilities?: { transfers?: string | null } | null;
}): boolean {
  return account.capabilities?.transfers === "active";
}
