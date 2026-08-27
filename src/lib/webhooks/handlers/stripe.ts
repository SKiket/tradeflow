import type Stripe from "stripe";

import { ORDER_STATUS } from "@/lib/orders/status";
import { releaseOrderReservation } from "@/lib/orders/reservations";
import { createAdminClient } from "@/lib/supabase/admin";

export interface StripeHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Processes a verified Stripe webhook event.
 *
 * The signature has already been checked upstream (constructEvent in the
 * ingress route), so we simply parse the raw JSON body here. Unknown/unhandled
 * event types are logged and acknowledged with 200 so Stripe does not retry.
 */
export async function handleStripeEvent(
  rawBody: string,
): Promise<StripeHandlerResult> {
  const event = JSON.parse(rawBody) as Stripe.Event;

  switch (event.type) {
    case "account.updated":
      return handleAccountUpdated(event.data.object as Stripe.Account);
    case "payment_intent.payment_failed":
      return handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
    case "checkout.session.expired":
      return handleCheckoutSessionExpired(
        event.data.object as Stripe.Checkout.Session,
      );
    default:
      console.info("[stripe-webhook] Unhandled event type", {
        type: event.type,
        id: event.id,
      });
      return {
        status: 200,
        body: { ok: true, handled: false, type: event.type },
      };
  }
}

async function resolveOrderIdFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): Promise<string | null> {
  const orderId = metadata?.order_id;
  return typeof orderId === "string" && orderId.length > 0 ? orderId : null;
}

async function handlePaymentFailed(
  paymentIntent: Stripe.PaymentIntent,
): Promise<StripeHandlerResult> {
  const orderId = await resolveOrderIdFromMetadata(paymentIntent.metadata);
  if (!orderId) {
    console.info("[stripe-webhook] payment_failed without order_id metadata", {
      paymentIntent: paymentIntent.id,
    });
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "no_order_id" },
    };
  }

  const supabase = createAdminClient();
  await releaseOrderReservation(supabase, orderId, ORDER_STATUS.PAYMENT_FAILED);

  console.info("[stripe-webhook] payment_failed — reservation released", {
    orderId,
    paymentIntent: paymentIntent.id,
  });

  return {
    status: 200,
    body: {
      ok: true,
      handled: true,
      type: "payment_intent.payment_failed",
      orderId,
    },
  };
}

async function handleCheckoutSessionExpired(
  session: Stripe.Checkout.Session,
): Promise<StripeHandlerResult> {
  let orderId = await resolveOrderIdFromMetadata(session.metadata);

  const supabase = createAdminClient();

  if (!orderId && session.id) {
    const { data: order } = await supabase
      .from("orders")
      .select("id")
      .eq("stripe_checkout_session_id", session.id)
      .maybeSingle();
    orderId = order?.id ?? null;
  }

  if (!orderId) {
    console.info("[stripe-webhook] checkout.session.expired without order", {
      session: session.id,
    });
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "no_order_id" },
    };
  }

  await releaseOrderReservation(supabase, orderId, ORDER_STATUS.EXPIRED);

  console.info("[stripe-webhook] checkout.session.expired — reservation released", {
    orderId,
    session: session.id,
  });

  return {
    status: 200,
    body: {
      ok: true,
      handled: true,
      type: "checkout.session.expired",
      orderId,
    },
  };
}

async function handleAccountUpdated(
  account: Stripe.Account,
): Promise<StripeHandlerResult> {
  const supabase = createAdminClient();

  const { data: business, error: lookupError } = await supabase
    .from("businesses")
    .select(
      "id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted",
    )
    .eq("stripe_connected_account_id", account.id)
    .maybeSingle();

  if (lookupError) {
    console.error("[stripe-webhook] account.updated lookup failed", {
      account: account.id,
      error: lookupError.message,
    });
    // Acknowledge with 200 so Stripe retries via a later event rather than
    // hammering the endpoint; the state will re-sync on the next update.
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "lookup_error" },
    };
  }

  if (!business) {
    // Event for an account that isn't a TradeFlow seller (e.g. unrelated test
    // events). Nothing to do — acknowledge so Stripe stops retrying.
    console.info("[stripe-webhook] account.updated for unknown account", {
      account: account.id,
    });
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "no_matching_business" },
    };
  }

  const next = {
    stripe_charges_enabled: account.charges_enabled ?? false,
    stripe_payouts_enabled: account.payouts_enabled ?? false,
    stripe_details_submitted: account.details_submitted ?? false,
  };

  logTransition(business.id, "charges_enabled", business.stripe_charges_enabled, next.stripe_charges_enabled);
  logTransition(business.id, "payouts_enabled", business.stripe_payouts_enabled, next.stripe_payouts_enabled);
  logTransition(business.id, "details_submitted", business.stripe_details_submitted, next.stripe_details_submitted);

  const { error: updateError } = await supabase
    .from("businesses")
    .update(next)
    .eq("id", business.id);

  if (updateError) {
    console.error("[stripe-webhook] account.updated write failed", {
      business: business.id,
      error: updateError.message,
    });
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "update_error" },
    };
  }

  return {
    status: 200,
    body: { ok: true, handled: true, type: "account.updated", business: business.id, ...next },
  };
}

function logTransition(
  businessId: string,
  field: string,
  from: boolean,
  to: boolean,
) {
  if (from !== to) {
    console.info(
      `[stripe-webhook] business ${businessId}: ${field} ${from} → ${to}`,
    );
  }
}
