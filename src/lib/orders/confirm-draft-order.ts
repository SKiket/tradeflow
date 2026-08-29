import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { ORDER_STATUS } from "@/lib/orders/status";
import {
  RESERVATION_MINUTES,
  checkOrderStockAvailable,
  releaseOrderReservation,
  reserveOrderStock,
  sweepExpiredReservations,
} from "@/lib/orders/reservations";
import {
  createOrderCheckoutSession,
  expireCheckoutSessionIfOpen,
} from "@/lib/stripe/checkout";

export type ConfirmDraftOutcome =
  | {
      action: "confirmed";
      orderId: string;
      orderRef: string;
      checkoutUrl: string;
      checkoutSessionId: string;
      outboundMessageId: string;
      usedAi: boolean;
    }
  | {
      action: "stock_unavailable";
      orderId: string;
      message: string;
      outboundMessageId: string;
    }
  | {
      action: "error";
      error: string;
    };

export interface ConfirmDraftOrderParams {
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string;
  orderId: string;
  usedAi: boolean;
  supabase: SupabaseClient;
}

async function cancelDraftOrder(
  supabase: SupabaseClient,
  orderId: string,
  businessId: string,
  fromStatus: string,
): Promise<void> {
  await supabase
    .from("orders")
    .update({ status: ORDER_STATUS.CANCELLED, reserved_until: null })
    .eq("id", orderId);

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: businessId,
    from_status: fromStatus,
    to_status: ORDER_STATUS.CANCELLED,
  });
}

/**
 * Buyer affirmed a PENDING_CONFIRMATION draft: sweep expired holds, re-check
 * stock, reserve, create Stripe Checkout, send payment link.
 */
export async function confirmDraftOrder(
  params: ConfirmDraftOrderParams,
): Promise<ConfirmDraftOutcome> {
  const { supabase, businessId, orderId } = params;

  const { data: business, error: bizError } = await supabase
    .from("businesses")
    .select("stripe_connected_account_id, stripe_charges_enabled")
    .eq("id", businessId)
    .maybeSingle();

  if (bizError || !business?.stripe_connected_account_id) {
    return {
      action: "error",
      error: "Seller Stripe account is not configured",
    };
  }
  if (!business.stripe_charges_enabled) {
    return {
      action: "error",
      error: "Seller Stripe account cannot accept charges yet",
    };
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, order_ref, status, total_pence")
    .eq("id", orderId)
    .eq("business_id", businessId)
    .eq("status", ORDER_STATUS.PENDING_CONFIRMATION)
    .maybeSingle();

  if (orderError || !order) {
    return { action: "error", error: "Draft order not found or already handled" };
  }

  await sweepExpiredReservations(supabase, businessId);

  const stock = await checkOrderStockAvailable(supabase, orderId);
  if (!stock.ok) {
    await cancelDraftOrder(
      supabase,
      orderId,
      businessId,
      ORDER_STATUS.PENDING_CONFIRMATION,
    );
    const message =
      "Sorry — we no longer have enough stock to fulfil that order. Nothing has been charged. Want to try a different item or quantity?";
    const sent = await sendWhatsAppMessage({
      businessId,
      toPhoneE164: params.customerPhoneE164,
      text: message,
      threadId: params.threadId,
      customerId: params.customerId,
      supabase,
    });
    return {
      action: "stock_unavailable",
      orderId,
      message,
      outboundMessageId: sent.messageId,
    };
  }

  await reserveOrderStock(supabase, orderId, businessId);

  const { data: items, error: itemsError } = await supabase
    .from("order_items")
    .select(
      "quantity, unit_price_pence, product_variant_id, product_variants(label, products(name))",
    )
    .eq("order_id", orderId);

  if (itemsError || !items?.length) {
    return { action: "error", error: "Order has no line items" };
  }

  const lineItems = items.map((item) => {
    const raw = item.product_variants as unknown;
    const variant = (Array.isArray(raw) ? raw[0] : raw) as {
      label: string | null;
      products: { name: string } | { name: string }[] | null;
    } | null;
    const productRaw = variant?.products;
    const product = Array.isArray(productRaw) ? productRaw[0] : productRaw;
    const productName = product?.name ?? "Item";
    const label = variant?.label ? ` (${variant.label})` : "";
    return {
      name: `${productName}${label}`,
      unitAmountPence: item.unit_price_pence as number,
      quantity: item.quantity as number,
    };
  });

  const expiresAtUnix = Math.floor(Date.now() / 1000) + RESERVATION_MINUTES * 60;

  let session;
  try {
    session = await createOrderCheckoutSession({
      connectedAccountId: business.stripe_connected_account_id,
      orderId,
      orderRef: order.order_ref,
      lineItems,
      expiresAtUnix,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[orders] Checkout session creation failed", { orderId, message });
    await releaseFailedReservation(supabase, orderId, businessId);
    return { action: "error", error: `Checkout creation failed: ${message}` };
  }

  if (!session.url) {
    await releaseFailedReservation(supabase, orderId, businessId);
    return { action: "error", error: "Checkout session has no URL" };
  }

  await supabase
    .from("orders")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", orderId);

  const paymentMessage = `Great — here's your secure payment link: ${session.url} — valid for ${RESERVATION_MINUTES} minutes.`;
  const sent = await sendWhatsAppMessage({
    businessId,
    toPhoneE164: params.customerPhoneE164,
    text: paymentMessage,
    threadId: params.threadId,
    customerId: params.customerId,
    supabase,
  });

  console.info("[orders] Payment link sent", {
    orderId,
    orderRef: order.order_ref,
    checkoutSessionId: session.id,
    usedAi: params.usedAi,
  });

  return {
    action: "confirmed",
    orderId,
    orderRef: order.order_ref,
    checkoutUrl: session.url,
    checkoutSessionId: session.id,
    outboundMessageId: sent.messageId,
    usedAi: params.usedAi,
  };
}

async function releaseFailedReservation(
  supabase: SupabaseClient,
  orderId: string,
  businessId: string,
): Promise<void> {
  const { data: items } = await supabase
    .from("order_items")
    .select("quantity, product_variant_id")
    .eq("order_id", orderId);

  for (const item of items ?? []) {
    const { data: variant } = await supabase
      .from("product_variants")
      .select("id, reserved_quantity, track_inventory")
      .eq("id", item.product_variant_id)
      .maybeSingle();
    if (!variant?.track_inventory) continue;
    await supabase
      .from("product_variants")
      .update({
        reserved_quantity: Math.max(
          0,
          (variant.reserved_quantity ?? 0) - item.quantity,
        ),
      })
      .eq("id", variant.id);
  }

  await supabase
    .from("orders")
    .update({ status: ORDER_STATUS.CANCELLED, reserved_until: null })
    .eq("id", orderId);

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: businessId,
    from_status: ORDER_STATUS.AWAITING_PAYMENT,
    to_status: ORDER_STATUS.CANCELLED,
  });
}

export type CancelDraftOutcome = {
  action: "cancelled";
  orderId: string;
  outboundMessageId: string;
};

/** Buyer declined a PENDING_CONFIRMATION draft — cancel without reserving. */
export async function cancelPendingDraft(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    customerId: string;
    customerPhoneE164: string;
    threadId: string;
    orderId: string;
  },
): Promise<CancelDraftOutcome> {
  await supabase
    .from("orders")
    .update({ status: ORDER_STATUS.CANCELLED })
    .eq("id", params.orderId);

  await supabase.from("order_status_history").insert({
    order_id: params.orderId,
    business_id: params.businessId,
    from_status: ORDER_STATUS.PENDING_CONFIRMATION,
    to_status: ORDER_STATUS.CANCELLED,
  });

  const sent = await sendWhatsAppMessage({
    businessId: params.businessId,
    toPhoneE164: params.customerPhoneE164,
    text: "No problem — I've cancelled that draft order. Just message us anytime if you'd like to order something else.",
    threadId: params.threadId,
    customerId: params.customerId,
    supabase,
  });

  return {
    action: "cancelled",
    orderId: params.orderId,
    outboundMessageId: sent.messageId,
  };
}

/** Find the open PENDING_CONFIRMATION draft on a thread, if any. */
export async function findPendingDraftForThread(
  supabase: SupabaseClient,
  businessId: string,
  threadId: string,
): Promise<{ id: string; order_ref: string } | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_ref")
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .eq("status", ORDER_STATUS.PENDING_CONFIRMATION)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(`Draft lookup failed: ${error.message}`);
  }
  return data;
}

/** Find the open AWAITING_PAYMENT order on a thread, if any. */
export async function findAwaitingPaymentForThread(
  supabase: SupabaseClient,
  businessId: string,
  threadId: string,
): Promise<{
  id: string;
  order_ref: string;
  stripe_checkout_session_id: string | null;
} | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_ref, stripe_checkout_session_id")
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .eq("status", ORDER_STATUS.AWAITING_PAYMENT)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(`Awaiting-payment lookup failed: ${error.message}`);
  }
  return data;
}

export type CancelAwaitingPaymentOutcome =
  | {
      action: "cancelled";
      orderId: string;
      checkoutSessionId: string | null;
      checkoutExpireOutcome: string;
      outboundMessageId?: string;
    }
  | {
      action: "error";
      error: string;
    };

/**
 * Buyer-initiated cancel (or supersede) of an AWAITING_PAYMENT order:
 * expire the Checkout Session if still open, release the stock hold, set
 * CANCELLED. Does not touch PAID-or-later orders.
 */
export async function cancelAwaitingPaymentOrder(params: {
  supabase: SupabaseClient;
  businessId: string;
  orderId: string;
  notifyBuyer?: boolean;
  customerId?: string;
  customerPhoneE164?: string;
  threadId?: string;
}): Promise<CancelAwaitingPaymentOutcome> {
  const { supabase, businessId, orderId } = params;

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, status, stripe_checkout_session_id")
    .eq("id", orderId)
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    return { action: "error", error: error.message };
  }
  if (!order) {
    return { action: "error", error: "Order not found" };
  }
  if (order.status === ORDER_STATUS.CANCELLED) {
    return {
      action: "cancelled",
      orderId,
      checkoutSessionId: order.stripe_checkout_session_id,
      checkoutExpireOutcome: "already_cancelled",
    };
  }
  if (order.status !== ORDER_STATUS.AWAITING_PAYMENT) {
    return {
      action: "error",
      error: `Order is ${order.status}, not AWAITING_PAYMENT`,
    };
  }

  const checkoutSessionId = order.stripe_checkout_session_id;
  let checkoutExpireOutcome = "no_session";

  if (checkoutSessionId) {
    const expired = await expireCheckoutSessionIfOpen(checkoutSessionId);
    checkoutExpireOutcome = expired.outcome;
    if (expired.outcome === "complete") {
      return {
        action: "error",
        error: "Payment already completed — cannot cancel pre-payment",
      };
    }
  }

  // Webhook for checkout.session.expired may already have set EXPIRED.
  const { data: current } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .maybeSingle();

  if (current?.status === ORDER_STATUS.AWAITING_PAYMENT) {
    await releaseOrderReservation(supabase, orderId, ORDER_STATUS.CANCELLED);
  } else if (current?.status === ORDER_STATUS.EXPIRED) {
    await supabase
      .from("orders")
      .update({ status: ORDER_STATUS.CANCELLED, reserved_until: null })
      .eq("id", orderId);
    await supabase.from("order_status_history").insert({
      order_id: orderId,
      business_id: businessId,
      from_status: ORDER_STATUS.EXPIRED,
      to_status: ORDER_STATUS.CANCELLED,
    });
  } else if (
    current?.status === ORDER_STATUS.PAID ||
    current?.status === ORDER_STATUS.DISPATCHED ||
    current?.status === ORDER_STATUS.DELIVERED ||
    current?.status === ORDER_STATUS.REFUND_PENDING ||
    current?.status === ORDER_STATUS.REFUNDED ||
    current?.status === ORDER_STATUS.PARTIALLY_REFUNDED
  ) {
    return {
      action: "error",
      error: `Order is ${current.status}, not cancellable in the pre-payment window`,
    };
  }

  let outboundMessageId: string | undefined;
  if (
    params.notifyBuyer &&
    params.customerPhoneE164 &&
    params.customerId &&
    params.threadId
  ) {
    try {
      const sent = await sendWhatsAppMessage({
        businessId,
        toPhoneE164: params.customerPhoneE164,
        text: "No problem — I've cancelled that order. The payment link is no longer valid. Message us anytime if you'd like to order something else.",
        threadId: params.threadId,
        customerId: params.customerId,
        supabase,
      });
      outboundMessageId = sent.messageId;
    } catch (notifyError) {
      const message =
        notifyError instanceof Error ? notifyError.message : String(notifyError);
      console.error("[orders] AWAITING_PAYMENT cancelled but buyer notify failed", {
        orderId,
        error: message,
      });
    }
  }

  console.info("[orders] AWAITING_PAYMENT cancelled", {
    orderId,
    checkoutSessionId,
    checkoutExpireOutcome,
    notifiedBuyer: Boolean(outboundMessageId),
  });

  return {
    action: "cancelled",
    orderId,
    checkoutSessionId,
    checkoutExpireOutcome,
    ...(outboundMessageId ? { outboundMessageId } : {}),
  };
}
