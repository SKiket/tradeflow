import type Stripe from "stripe";

import { fulfilPaidOrder, notifyBuyerPaymentFailed } from "@/lib/orders/fulfil-order";
import { processRefundUpdated } from "@/lib/orders/refund-order";
import { persistOrderShippingAddress, shippingAddressFromSession } from "@/lib/orders/shipping-address";
import { resolveOrderIdFromCheckoutSession } from "@/lib/orders/resolve-order-from-checkout";
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
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(
        event.data.object as Stripe.Checkout.Session,
      );
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutAsyncPaymentSucceeded(
        event.data.object as Stripe.Checkout.Session,
      );
    case "checkout.session.async_payment_failed":
      return handleCheckoutAsyncPaymentFailed(
        event.data.object as Stripe.Checkout.Session,
      );
    case "refund.updated":
      return handleRefundUpdated(event.data.object as Stripe.Refund);
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

/**
 * checkout.session.completed — synchronous card payments fulfil when
 * payment_status === 'paid'. Delayed methods (Pay by Bank) log and wait
 * for checkout.session.async_payment_succeeded.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<StripeHandlerResult> {
  const supabase = createAdminClient();
  const orderId = await resolveOrderIdFromCheckoutSession(supabase, session);

  if (!orderId) {
    console.info("[stripe-webhook] checkout.session.completed without order", {
      session: session.id,
    });
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "no_order_id" },
    };
  }

  const paymentStatus = session.payment_status;
  const shippingAddress = shippingAddressFromSession(session);
  await persistOrderShippingAddress(supabase, orderId, shippingAddress);

  if (paymentStatus === "paid") {
    const result = await fulfilPaidOrder(supabase, orderId, { shippingAddress });
    console.info("[stripe-webhook] checkout.session.completed — paid", {
      orderId,
      session: session.id,
      fulfilAction: result.action,
    });
    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        type: "checkout.session.completed",
        paymentStatus,
        orderId,
        fulfil: result,
      },
    };
  }

  console.info(
    "[stripe-webhook] checkout.session.completed — payment pending (awaiting async event)",
    {
      orderId,
      session: session.id,
      paymentStatus,
    },
  );

  return {
    status: 200,
    body: {
      ok: true,
      handled: true,
      type: "checkout.session.completed",
      paymentStatus,
      orderId,
      fulfil: { action: "deferred", reason: "async_payment_pending" },
    },
  };
}

/** Delayed notification success (e.g. Pay by Bank cleared). */
async function handleCheckoutAsyncPaymentSucceeded(
  session: Stripe.Checkout.Session,
): Promise<StripeHandlerResult> {
  const supabase = createAdminClient();
  const orderId = await resolveOrderIdFromCheckoutSession(supabase, session);

  if (!orderId) {
    console.info(
      "[stripe-webhook] checkout.session.async_payment_succeeded without order",
      { session: session.id },
    );
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "no_order_id" },
    };
  }

  const shippingAddress = shippingAddressFromSession(session);
  await persistOrderShippingAddress(supabase, orderId, shippingAddress);

  const result = await fulfilPaidOrder(supabase, orderId, { shippingAddress });
  console.info("[stripe-webhook] checkout.session.async_payment_succeeded", {
    orderId,
    session: session.id,
    fulfilAction: result.action,
  });

  return {
    status: 200,
    body: {
      ok: true,
      handled: true,
      type: "checkout.session.async_payment_succeeded",
      orderId,
      fulfil: result,
    },
  };
}

/** Delayed notification failure (e.g. Pay by Bank rejected). */
async function handleCheckoutAsyncPaymentFailed(
  session: Stripe.Checkout.Session,
): Promise<StripeHandlerResult> {
  const supabase = createAdminClient();
  const orderId = await resolveOrderIdFromCheckoutSession(supabase, session);

  if (!orderId) {
    console.info(
      "[stripe-webhook] checkout.session.async_payment_failed without order",
      { session: session.id },
    );
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "no_order_id" },
    };
  }

  const { data: order } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .maybeSingle();

  if (order?.status === ORDER_STATUS.AWAITING_PAYMENT) {
    await releaseOrderReservation(supabase, orderId, ORDER_STATUS.PAYMENT_FAILED);
    await notifyBuyerPaymentFailed(supabase, orderId);
  }

  console.info("[stripe-webhook] checkout.session.async_payment_failed", {
    orderId,
    session: session.id,
    priorStatus: order?.status,
  });

  return {
    status: 200,
    body: {
      ok: true,
      handled: true,
      type: "checkout.session.async_payment_failed",
      orderId,
    },
  };
}

async function handleRefundUpdated(
  refund: Stripe.Refund,
): Promise<StripeHandlerResult> {
  const result = await processRefundUpdated(refund);
  console.info("[stripe-webhook] refund.updated", {
    refundId: refund.id,
    status: refund.status,
    result,
  });
  return {
    status: 200,
    body: {
      ok: true,
      handled: result.action !== "skipped",
      type: "refund.updated",
      refund: result,
    },
  };
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

/**
 * checkout.session.expired — Stripe's 24h backstop (or an explicit expire).
 *
 * Compare-and-swap inside releaseOrderReservation: if payment_chase already
 * set CANCELLED, this is a no-op (stock is not released twice). If this
 * wins first, the order becomes EXPIRED and the next chase tick upgrades
 * it to CANCELLED and notifies the buyer.
 */
async function handleCheckoutSessionExpired(
  session: Stripe.Checkout.Session,
): Promise<StripeHandlerResult> {
  const supabase = createAdminClient();
  let orderId = await resolveOrderIdFromCheckoutSession(supabase, session);

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
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "lookup_error" },
    };
  }

  if (!business) {
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
