import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { ORDER_STATUS } from "@/lib/orders/status";
import { capturePaymentIntentForOrder } from "@/lib/stripe/capture-payment-intent";

export type FulfilOrderOutcome =
  | {
      action: "fulfilled";
      orderId: string;
      orderRef: string;
      buyerMessageId: string;
      sellerMessageId: string | null;
    }
  | { action: "already_fulfilled"; orderId: string; orderRef: string }
  | { action: "skipped"; orderId: string; reason: string };

interface OrderRow {
  id: string;
  order_ref: string;
  business_id: string;
  customer_id: string;
  thread_id: string | null;
  total_pence: number;
  status: string;
}

function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/**
 * Mark an AWAITING_PAYMENT order PAID and convert reservations to permanent
 * stock decrements. Idempotent — safe under webhook redelivery.
 *
 * Uses PAID (not CONFIRMED) as the terminal success status: payment has
 * cleared and inventory is committed; downstream dispatch flows can key off PAID.
 */
export async function fulfilPaidOrder(
  supabase: SupabaseClient,
  orderId: string,
): Promise<FulfilOrderOutcome> {
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(
      "id, order_ref, business_id, customer_id, thread_id, total_pence, status",
    )
    .eq("id", orderId)
    .maybeSingle();

  if (orderError || !order) {
    return { action: "skipped", orderId, reason: "order_not_found" };
  }

  const row = order as OrderRow;

  if (row.status === ORDER_STATUS.PAID) {
    console.info("[orders] fulfil skipped — already PAID", { orderId });
    return {
      action: "already_fulfilled",
      orderId,
      orderRef: row.order_ref,
    };
  }

  if (row.status !== ORDER_STATUS.AWAITING_PAYMENT) {
    console.info("[orders] fulfil skipped — unexpected status", {
      orderId,
      status: row.status,
    });
    return { action: "skipped", orderId, reason: `status_${row.status}` };
  }

  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    "fulfil_paid_order",
    { p_order_id: orderId },
  );

  if (rpcError) {
    throw new Error(`fulfil_paid_order RPC failed: ${rpcError.message}`);
  }

  const outcome = typeof rpcResult === "string" ? rpcResult : String(rpcResult);

  if (outcome === "already_fulfilled") {
    return {
      action: "already_fulfilled",
      orderId,
      orderRef: row.order_ref,
    };
  }

  if (outcome !== "fulfilled") {
    return { action: "skipped", orderId, reason: outcome };
  }

  try {
    await capturePaymentIntentForOrder(orderId);
  } catch (err) {
    console.error("[orders] Failed to capture payment_intent_id", {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("phone_e164")
    .eq("id", row.customer_id)
    .maybeSingle();

  const { data: business } = await supabase
    .from("businesses")
    .select("name, seller_whatsapp_phone_e164")
    .eq("id", row.business_id)
    .maybeSingle();

  const buyerPhone = customer?.phone_e164;
  let buyerMessageId = "";

  if (!buyerPhone) {
    console.error("[orders] fulfil: buyer phone missing", { orderId });
  } else {
    const buyerText = [
      `Payment received! Your order ${row.order_ref} is confirmed.`,
      `Total: ${formatPence(row.total_pence)}.`,
      "",
      "We'll be in touch about dispatch. Thanks for your order!",
    ].join("\n");

    const buyerSent = await sendWhatsAppMessage({
      businessId: row.business_id,
      toPhoneE164: buyerPhone,
      text: buyerText,
      threadId: row.thread_id,
      customerId: row.customer_id,
      supabase,
    });
    buyerMessageId = buyerSent.messageId;
  }

  let sellerMessageId: string | null = null;
  const sellerPhone = business?.seller_whatsapp_phone_e164;
  if (!sellerPhone) {
    console.warn("[orders] fulfil: no seller_whatsapp_phone_e164 — seller notify skipped", {
      orderId,
      businessId: row.business_id,
    });
  } else {
    const { data: items } = await supabase
      .from("order_items")
      .select(
        "quantity, unit_price_pence, product_variants(label, products(name))",
      )
      .eq("order_id", orderId);

    const lines = (items ?? []).map((item) => {
      const raw = item.product_variants as unknown;
      const variant = (Array.isArray(raw) ? raw[0] : raw) as {
        label: string | null;
        products: { name: string } | { name: string }[] | null;
      } | null;
      const productRaw = variant?.products;
      const product = Array.isArray(productRaw) ? productRaw[0] : productRaw;
      const name = product?.name ?? "Item";
      const label = variant?.label ? ` (${variant.label})` : "";
      return `• ${item.quantity}× ${name}${label}`;
    });

    const sellerText = [
      `New paid order ${row.order_ref}!`,
      ...lines,
      "",
      `Total: ${formatPence(row.total_pence)}`,
    ].join("\n");

    const sent = await sendWhatsAppMessage({
      businessId: row.business_id,
      toPhoneE164: sellerPhone,
      text: sellerText,
      supabase,
    });
    sellerMessageId = sent.messageId;
  }

  console.info("[orders] Order fulfilled", {
    orderId,
    orderRef: row.order_ref,
    sellerNotified: !!sellerMessageId,
  });

  return {
    action: "fulfilled",
    orderId,
    orderRef: row.order_ref,
    buyerMessageId,
    sellerMessageId,
  };
}

/** Notify buyer after async Pay by Bank failure; reservation already released. */
export async function notifyBuyerPaymentFailed(
  supabase: SupabaseClient,
  orderId: string,
): Promise<void> {
  const { data: order } = await supabase
    .from("orders")
    .select("id, order_ref, business_id, customer_id, thread_id")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) return;

  const { data: customer } = await supabase
    .from("customers")
    .select("phone_e164")
    .eq("id", order.customer_id)
    .maybeSingle();

  if (!customer?.phone_e164) return;

  await sendWhatsAppMessage({
    businessId: order.business_id,
    toPhoneE164: customer.phone_e164,
    text: [
      `Sorry — your payment for order ${order.order_ref} didn't go through.`,
      "We've released the items back to stock. Reply anytime if you'd like to order again.",
    ].join(" "),
    threadId: order.thread_id,
    customerId: order.customer_id,
    supabase,
  });
}
