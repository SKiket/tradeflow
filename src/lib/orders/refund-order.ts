import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import {
  ORDER_STATUS,
  REFUNDABLE_STATUSES,
} from "@/lib/orders/status";
import { getStripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/admin";

export type InitiateRefundOutcome =
  | {
      action: "refund_pending";
      orderId: string;
      orderRef: string;
      stripeRefundId: string;
      amountPence: number;
      priorStatus: string;
    }
  | { action: "invalid_status"; orderId: string; status: string }
  | { action: "amount_exceeds_refundable"; orderId: string; requested: number; refundable: number }
  | { action: "missing_payment_intent"; orderId: string }
  | { action: "refund_in_progress"; orderId: string };

export type ProcessRefundUpdatedOutcome =
  | { action: "succeeded"; orderId: string; stripeRefundId: string; alreadyProcessed: boolean }
  | { action: "failed"; orderId: string; stripeRefundId: string; revertedTo: string }
  | { action: "pending"; orderId: string; stripeRefundId: string }
  | { action: "skipped"; reason: string };

interface OrderRow {
  id: string;
  order_ref: string;
  business_id: string;
  customer_id: string;
  thread_id: string | null;
  status: string;
  total_pence: number;
  refunded_amount_pence: number;
  stripe_payment_intent_id: string | null;
}

function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function refundableAmount(order: OrderRow): number {
  return Math.max(0, order.total_pence - (order.refunded_amount_pence ?? 0));
}

/**
 * Owner-initiated refund: calls Stripe, sets REFUND_PENDING immediately.
 * Final status is determined by refund.updated webhook — not this call's response.
 *
 * Stock is intentionally NOT restocked; physical returns are out of scope.
 */
export async function initiateRefund(
  supabase: SupabaseClient,
  orderId: string,
  options?: { amountPence?: number; reason?: string },
): Promise<InitiateRefundOutcome> {
  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, order_ref, business_id, customer_id, thread_id, status, total_pence, refunded_amount_pence, stripe_payment_intent_id",
    )
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!order) throw new Error("ORDER_NOT_FOUND");

  const row = order as OrderRow;

  if (row.status === ORDER_STATUS.REFUND_PENDING) {
    return { action: "refund_in_progress", orderId };
  }

  if (!(REFUNDABLE_STATUSES as readonly string[]).includes(row.status)) {
    return { action: "invalid_status", orderId, status: row.status };
  }

  if (!row.stripe_payment_intent_id) {
    return { action: "missing_payment_intent", orderId };
  }

  const remaining = refundableAmount(row);
  const amountPence =
    options?.amountPence !== undefined && options.amountPence !== null
      ? Math.floor(options.amountPence)
      : remaining;

  if (amountPence <= 0) {
    return {
      action: "amount_exceeds_refundable",
      orderId,
      requested: amountPence,
      refundable: remaining,
    };
  }

  if (amountPence > remaining) {
    return {
      action: "amount_exceeds_refundable",
      orderId,
      requested: amountPence,
      refundable: remaining,
    };
  }

  const priorStatus = row.status;
  const reasonText = options?.reason?.trim() || null;

  const stripeRefund = await getStripe().refunds.create({
    payment_intent: row.stripe_payment_intent_id,
    amount: amountPence,
    reverse_transfer: true,
    reason: "requested_by_customer",
    metadata: {
      order_id: orderId,
      order_ref: row.order_ref,
      ...(reasonText ? { refund_reason: reasonText } : {}),
    },
  });

  const { error: ledgerError } = await supabase.from("order_refunds").insert({
    order_id: orderId,
    business_id: row.business_id,
    stripe_refund_id: stripeRefund.id,
    amount_pence: amountPence,
    status: "pending",
    reason: reasonText,
    prior_order_status: priorStatus,
  });

  if (ledgerError) {
    throw new Error(`Failed to record refund ledger: ${ledgerError.message}`);
  }

  const { error: updateError } = await supabase
    .from("orders")
    .update({ status: ORDER_STATUS.REFUND_PENDING })
    .eq("id", orderId)
    .in("status", [...REFUNDABLE_STATUSES]);

  if (updateError) {
    throw new Error(updateError.message);
  }

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: row.business_id,
    from_status: priorStatus,
    to_status: ORDER_STATUS.REFUND_PENDING,
  });

  return {
    action: "refund_pending",
    orderId,
    orderRef: row.order_ref,
    stripeRefundId: stripeRefund.id,
    amountPence,
    priorStatus,
  };
}

/**
 * Process refund.updated webhook — source of truth for final refund state.
 */
export async function processRefundUpdated(
  refund: Stripe.Refund,
): Promise<ProcessRefundUpdatedOutcome> {
  const supabase = createAdminClient();
  const paymentIntentId =
    typeof refund.payment_intent === "string"
      ? refund.payment_intent
      : refund.payment_intent?.id;

  if (!paymentIntentId) {
    return { action: "skipped", reason: "no_payment_intent" };
  }

  const { data: order } = await supabase
    .from("orders")
    .select(
      "id, order_ref, business_id, customer_id, thread_id, status, total_pence, refunded_amount_pence",
    )
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (!order) {
    return { action: "skipped", reason: "order_not_found" };
  }

  const { data: ledger } = await supabase
    .from("order_refunds")
    .select("id, status, amount_pence, prior_order_status, reason")
    .eq("stripe_refund_id", refund.id)
    .maybeSingle();

  if (!ledger) {
    return { action: "skipped", reason: "refund_not_in_ledger" };
  }

  if (ledger.status === "succeeded" && refund.status === "succeeded") {
    return {
      action: "succeeded",
      orderId: order.id,
      stripeRefundId: refund.id,
      alreadyProcessed: true,
    };
  }

  if (refund.status === "pending") {
    await supabase
      .from("order_refunds")
      .update({ status: "pending" })
      .eq("stripe_refund_id", refund.id);
    return { action: "pending", orderId: order.id, stripeRefundId: refund.id };
  }

  if (refund.status === "failed" || refund.status === "canceled") {
    await supabase
      .from("order_refunds")
      .update({ status: "failed" })
      .eq("stripe_refund_id", refund.id);

    const revertTo = ledger.prior_order_status;
    await supabase
      .from("orders")
      .update({ status: revertTo })
      .eq("id", order.id)
      .eq("status", ORDER_STATUS.REFUND_PENDING);

    await supabase.from("order_status_history").insert({
      order_id: order.id,
      business_id: order.business_id,
      from_status: ORDER_STATUS.REFUND_PENDING,
      to_status: revertTo,
    });

    await notifySellerRefundFailed(order.business_id, order.order_ref, refund.id);

    return {
      action: "failed",
      orderId: order.id,
      stripeRefundId: refund.id,
      revertedTo: revertTo,
    };
  }

  if (refund.status === "succeeded") {
    const newRefunded = (order.refunded_amount_pence ?? 0) + ledger.amount_pence;
    const finalStatus =
      newRefunded >= order.total_pence
        ? ORDER_STATUS.REFUNDED
        : ORDER_STATUS.PARTIALLY_REFUNDED;

    await supabase
      .from("order_refunds")
      .update({ status: "succeeded" })
      .eq("stripe_refund_id", refund.id);

    await supabase
      .from("orders")
      .update({
        refunded_amount_pence: newRefunded,
        status: finalStatus,
      })
      .eq("id", order.id);

    await supabase.from("order_status_history").insert({
      order_id: order.id,
      business_id: order.business_id,
      from_status: ORDER_STATUS.REFUND_PENDING,
      to_status: finalStatus,
    });

    await notifyBuyerRefundSucceeded({
      order: order as OrderRow,
      amountPence: ledger.amount_pence,
      reason: ledger.reason,
      isFullRefund: finalStatus === ORDER_STATUS.REFUNDED,
    });

    return {
      action: "succeeded",
      orderId: order.id,
      stripeRefundId: refund.id,
      alreadyProcessed: false,
    };
  }

  return { action: "skipped", reason: `status_${refund.status}` };
}

async function notifyBuyerRefundSucceeded(params: {
  order: OrderRow;
  amountPence: number;
  reason: string | null;
  isFullRefund: boolean;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("phone_e164")
    .eq("id", params.order.customer_id)
    .maybeSingle();

  if (!customer?.phone_e164) return;

  const lines = [
    params.isFullRefund
      ? `A full refund of ${formatPence(params.amountPence)} has been processed for order ${params.order.order_ref}.`
      : `A partial refund of ${formatPence(params.amountPence)} has been processed for order ${params.order.order_ref}.`,
  ];
  if (params.reason) {
    lines.push(`Reason: ${params.reason}`);
  }
  lines.push("", "The refund should appear in your account within a few business days.");

  await sendWhatsAppMessage({
    businessId: params.order.business_id,
    toPhoneE164: customer.phone_e164,
    text: lines.join("\n"),
    threadId: params.order.thread_id,
    customerId: params.order.customer_id,
    supabase: admin,
  });
}

async function notifySellerRefundFailed(
  businessId: string,
  orderRef: string,
  stripeRefundId: string,
): Promise<void> {
  const admin = createAdminClient();
  const { data: business } = await admin
    .from("businesses")
    .select("seller_whatsapp_phone_e164")
    .eq("id", businessId)
    .maybeSingle();

  if (!business?.seller_whatsapp_phone_e164) {
    console.warn("[orders/refund] seller notify skipped — no seller_whatsapp_phone_e164", {
      businessId,
    });
    return;
  }

  await sendWhatsAppMessage({
    businessId,
    toPhoneE164: business.seller_whatsapp_phone_e164,
    text: [
      `Refund failed for order ${orderRef} (${stripeRefundId}).`,
      "Please check your Stripe dashboard and retry or handle manually.",
    ].join(" "),
    supabase: admin,
  });
}

/** Exported for tests — buyer refund notification text builder. */
export function buildBuyerRefundMessage(params: {
  orderRef: string;
  amountPence: number;
  reason: string | null;
  isFullRefund: boolean;
}): string {
  const lines = [
    params.isFullRefund
      ? `A full refund of ${formatPence(params.amountPence)} has been processed for order ${params.orderRef}.`
      : `A partial refund of ${formatPence(params.amountPence)} has been processed for order ${params.orderRef}.`,
  ];
  if (params.reason) lines.push(`Reason: ${params.reason}`);
  lines.push("", "The refund should appear in your account within a few business days.");
  return lines.join("\n");
}
