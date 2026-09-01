import type Stripe from "stripe";

import { fulfilPaidOrder, notifyBuyerPaymentFailed } from "@/lib/orders/fulfil-order";
import { processRefundUpdated } from "@/lib/orders/refund-order";
import { persistOrderShippingAddress, shippingAddressFromSession } from "@/lib/orders/shipping-address";
import { resolveOrderIdFromCheckoutSession } from "@/lib/orders/resolve-order-from-checkout";
import { ORDER_STATUS } from "@/lib/orders/status";
import { releaseOrderReservation } from "@/lib/orders/reservations";
import {
  isSellerSubscriptionStatus,
  trialEndsAtFromUnix,
} from "@/lib/stripe/billing";
import { getStripe } from "@/lib/stripe/client";
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
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return handleSellerSubscription(
        event.data.object as Stripe.Subscription,
        event.type,
      );
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
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
  if (session.mode === "subscription") {
    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        type: "checkout.session.completed",
        mode: "subscription",
        reason: "subscription_status_comes_from_subscription_events",
      },
    };
  }

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

async function handleSellerSubscription(
  subscription: Stripe.Subscription,
  eventType: string,
): Promise<StripeHandlerResult> {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  if (!customerId) {
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "no_customer" },
    };
  }

  const status = eventType === "customer.subscription.deleted"
    ? "canceled"
    : subscription.status;
  const synced = await syncSellerSubscription({
    customerId,
    subscriptionId: subscription.id,
    status,
    trialEnd: subscription.trial_end,
  });

  return {
    status: 200,
    body: {
      ok: true,
      handled: synced.handled,
      type: eventType,
      ...synced,
    },
  };
}

function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const parent = invoice.parent;
  if (!parent || parent.type !== "subscription_details") return null;
  const sub = parent.subscription_details?.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object" && "id" in sub) return sub.id;
  return null;
}

async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<StripeHandlerResult> {
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  const subscriptionId = subscriptionIdFromInvoice(invoice);

  if (!customerId) {
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "no_customer" },
    };
  }

  if (!subscriptionId) {
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "not_a_subscription_invoice" },
    };
  }

  let status: string = "past_due";
  let trialEnd: number | null | undefined = undefined;
  try {
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    status = subscription.status;
    trialEnd = subscription.trial_end;
  } catch (error) {
    console.error("[stripe-webhook] invoice.payment_failed retrieve failed", {
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const synced = await syncSellerSubscription({
    customerId,
    subscriptionId,
    status,
    trialEnd,
  });

  return {
    status: 200,
    body: {
      ok: true,
      handled: synced.handled,
      type: "invoice.payment_failed",
      ...synced,
    },
  };
}

async function syncSellerSubscription(params: {
  customerId: string;
  subscriptionId: string | null;
  status: string;
  trialEnd: number | null | undefined;
}): Promise<{
  handled: boolean;
  reason?: string;
  business?: string;
  stripe_subscription_status?: string | null;
  trial_ends_at?: string | null;
}> {
  const supabase = createAdminClient();
  const { data: business, error: lookupError } = await supabase
    .from("businesses")
    .select("id, stripe_subscription_status, trial_ends_at")
    .eq("stripe_customer_id", params.customerId)
    .is("deleted_at", null)
    .maybeSingle();

  if (lookupError) {
    console.error("[stripe-webhook] subscription lookup failed", {
      customer: params.customerId,
      error: lookupError.message,
    });
    return { handled: false, reason: "lookup_error" };
  }

  if (!business) {
    console.info("[stripe-webhook] subscription event for unknown customer", {
      customer: params.customerId,
    });
    return { handled: false, reason: "no_matching_business" };
  }

  const nextStatus = isSellerSubscriptionStatus(params.status)
    ? params.status
    : null;
  if (!nextStatus) {
    console.warn("[stripe-webhook] unrecognised subscription status", {
      business: business.id,
      status: params.status,
    });
    return { handled: false, reason: "unrecognised_status", business: business.id };
  }

  const next: {
    stripe_subscription_status: string;
    stripe_subscription_id?: string;
    trial_ends_at?: string | null;
  } = {
    stripe_subscription_status: nextStatus,
  };
  if (params.subscriptionId) {
    next.stripe_subscription_id = params.subscriptionId;
  }
  if (params.trialEnd !== undefined) {
    next.trial_ends_at = trialEndsAtFromUnix(params.trialEnd);
  }

  const { error: updateError } = await supabase
    .from("businesses")
    .update(next)
    .eq("id", business.id);

  if (updateError) {
    console.error("[stripe-webhook] subscription write failed", {
      business: business.id,
      error: updateError.message,
    });
    return { handled: false, reason: "update_error", business: business.id };
  }

  console.info("[stripe-webhook] seller subscription synced", {
    business: business.id,
    from: business.stripe_subscription_status,
    to: nextStatus,
  });

  return {
    handled: true,
    business: business.id,
    stripe_subscription_status: nextStatus,
    trial_ends_at: next.trial_ends_at ?? business.trial_ends_at,
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
