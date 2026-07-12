import type Stripe from "stripe";

import { getStripe } from "@/lib/stripe/client";

/**
 * Create a PaymentIntent as a destination charge to a seller's connected
 * account.
 *
 * The charge is created on the platform account and the funds are routed to
 * the seller via `transfer_data.destination`. Both Pay by Bank (UK Open
 * Banking) and card are enabled as payment method types.
 *
 * This is a minimal stub to prove PaymentIntent creation and destination
 * routing — there is no buyer-facing checkout UI yet.
 *
 * @see https://docs.stripe.com/connect/destination-charges
 */
export async function createDestinationPaymentIntent(params: {
  connectedAccountId: string;
  amountPence: number;
  currency?: string;
  applicationFeePence?: number;
  orderRef?: string;
}): Promise<Stripe.PaymentIntent> {
  const {
    connectedAccountId,
    amountPence,
    currency = "gbp",
    applicationFeePence,
    orderRef,
  } = params;

  return getStripe().paymentIntents.create({
    amount: amountPence,
    currency,
    payment_method_types: ["card", "pay_by_bank"],
    transfer_data: { destination: connectedAccountId },
    ...(applicationFeePence !== undefined
      ? { application_fee_amount: applicationFeePence }
      : {}),
    ...(orderRef ? { metadata: { tradeflow_order_ref: orderRef } } : {}),
  });
}
