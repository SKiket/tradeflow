export type StripeConnectFlags = {
  connectedAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

/**
 * Map the three cached Stripe Connect booleans to seller-facing copy.
 *
 *   charges + payouts → taking payments and receiving payouts
 *   details submitted, charges off → Stripe still reviewing
 *   no account / details not submitted → onboarding not finished
 */
export function stripePaymentsStatus(flags: StripeConnectFlags): {
  headline: string;
  detail: string;
} {
  const connected = Boolean(flags.connectedAccountId);

  if (flags.chargesEnabled && flags.payoutsEnabled) {
    return {
      headline: "Payments: Active",
      detail: "Charges and payouts are enabled on this Stripe account.",
    };
  }

  if (flags.chargesEnabled && !flags.payoutsEnabled) {
    return {
      headline: "Payments: Active",
      detail:
        "You can take payments. Payouts are still pending Stripe approval.",
    };
  }

  if (flags.detailsSubmitted && !flags.chargesEnabled) {
    return {
      headline: "Payments: Pending Stripe review",
      detail:
        "Onboarding details were submitted. Stripe has not enabled charges yet.",
    };
  }

  if (!connected || !flags.detailsSubmitted) {
    return {
      headline: "Payments: Setup incomplete",
      detail: connected
        ? "Stripe onboarding is not finished, so charges are not enabled yet."
        : "No Stripe account is connected yet.",
    };
  }

  return {
    headline: "Payments: Pending Stripe review",
    detail: "Stripe has the account but charges are not enabled yet.",
  };
}

export function whatsappConnectionStatus(phoneE164: string | null): {
  headline: string;
  detail: string;
} {
  const phone = phoneE164?.trim() ?? "";
  if (phone) {
    return {
      headline: "WhatsApp: Connected",
      detail: `Inbound number ${phone}. Reconnection is not available here.`,
    };
  }
  return {
    headline: "WhatsApp: Not connected",
    detail:
      "No WhatsApp number is mapped to this business yet. Connection setup is handled separately.",
  };
}
