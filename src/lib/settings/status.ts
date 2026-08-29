export type StripeConnectFlags = {
  connectedAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

/**
 * Map stripe_charges_enabled / stripe_payouts_enabled / stripe_details_submitted
 * to seller-facing copy. All eight boolean combinations collapse to three
 * headlines:
 *
 *   charges on                  → Payments: Active
 *   charges off, details on     → Payments: Pending Stripe review
 *   charges off, details off    → Payments: Setup incomplete
 */
export function stripePaymentsStatus(flags: StripeConnectFlags): {
  headline: string;
  detail: string;
} {
  const connected = Boolean(flags.connectedAccountId);

  if (flags.chargesEnabled) {
    if (flags.payoutsEnabled) {
      return {
        headline: "Payments: Active",
        detail: "Charges and payouts are enabled on this Stripe account.",
      };
    }
    return {
      headline: "Payments: Active",
      detail:
        "You can take payments. Payouts are still pending Stripe approval.",
    };
  }

  if (flags.detailsSubmitted) {
    return {
      headline: "Payments: Pending Stripe review",
      detail:
        "Onboarding details were submitted. Stripe has not enabled charges yet.",
    };
  }

  return {
    headline: "Payments: Setup incomplete",
    detail: connected
      ? "Stripe onboarding is not finished, so charges are not enabled yet."
      : "No Stripe account is connected yet.",
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
      detail: `Inbound number ${phone}.`,
    };
  }
  return {
    headline: "WhatsApp: Not connected",
    detail: "No WhatsApp number is mapped to this business yet.",
  };
}
