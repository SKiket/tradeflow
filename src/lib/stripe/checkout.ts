import type Stripe from "stripe";

import { reservationExpiryUnix } from "@/lib/orders/reservations";
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
    shipping_address_collection: {
      allowed_countries: ["GB"],
    },
    success_url: `${base}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pay/cancelled?order_ref=${encodeURIComponent(params.orderRef)}`,
    // Explicit 24h (Stripe's max / default). Callers pass the same unix
    // used for orders.reserved_until so the two clocks stay aligned.
    expires_at: params.expiresAtUnix ?? reservationExpiryUnix(),
  });

  return session;
}

export type ExpireCheckoutOutcome =
  | { outcome: "expired"; status: string }
  | { outcome: "already_expired"; status: string }
  | { outcome: "complete"; status: string }
  | { outcome: "missing" };

/**
 * Return the hosted Checkout URL when the session is still open.
 * Used by payment-chase reminders so we never send an already-expired link.
 */
export async function getOpenCheckoutUrl(
  sessionId: string,
): Promise<string | null> {
  const stripe = getStripe();
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "open" && typeof session.url === "string") {
      return session.url;
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such checkout session/i.test(message)) {
      return null;
    }
    throw error;
  }
}

/**
 * Expire an open Checkout Session so its payment link stops working.
 * No-ops when already expired; reports "complete" when the buyer already paid
 * so callers must not cancel a fulfilled order.
 */
export async function expireCheckoutSessionIfOpen(
  sessionId: string,
): Promise<ExpireCheckoutOutcome> {
  const stripe = getStripe();
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "complete") {
      return { outcome: "complete", status: session.status };
    }
    if (session.status === "expired") {
      return { outcome: "already_expired", status: session.status };
    }
    if (session.status !== "open") {
      return {
        outcome: "already_expired",
        status: session.status ?? "unknown",
      };
    }
    const expired = await stripe.checkout.sessions.expire(sessionId);
    return { outcome: "expired", status: expired.status ?? "expired" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such checkout session/i.test(message)) {
      return { outcome: "missing" };
    }
    throw error;
  }
}
