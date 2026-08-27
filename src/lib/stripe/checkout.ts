import type Stripe from "stripe";

import { getStripe } from "@/lib/stripe/client";

function getAppBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

export interface CheckoutLineItem {
  name: string;
  unitAmountPence: number;
  quantity: number;
}

/**
 * Create a hosted Stripe Checkout Session (destination charge).
 *
 * Uses Checkout — not a raw PaymentIntent — so we get a shareable URL
 * suitable for WhatsApp. Funds route to the seller's connected account.
 */
export async function createOrderCheckoutSession(params: {
  connectedAccountId: string;
  orderId: string;
  orderRef: string;
  lineItems: CheckoutLineItem[];
  expiresAtUnix?: number;
}): Promise<Stripe.Checkout.Session> {
  const base = getAppBaseUrl();
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card", "pay_by_bank"],
    line_items: params.lineItems.map((item) => ({
      price_data: {
        currency: "gbp",
        unit_amount: item.unitAmountPence,
        product_data: { name: item.name },
      },
      quantity: item.quantity,
    })),
    payment_intent_data: {
      transfer_data: { destination: params.connectedAccountId },
      metadata: {
        order_id: params.orderId,
        order_ref: params.orderRef,
      },
    },
    metadata: {
      order_id: params.orderId,
      order_ref: params.orderRef,
    },
    success_url: `${base}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pay/cancelled?order_ref=${encodeURIComponent(params.orderRef)}`,
    ...(params.expiresAtUnix
      ? { expires_at: params.expiresAtUnix }
      : {}),
  });

  return session;
}
