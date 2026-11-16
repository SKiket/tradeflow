import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { notifySellerFraudWarning } from "@/lib/disputes/notify";
import { getStripe } from "@/lib/stripe/client";

export type FraudWarningResult = {
  handled: boolean;
  action: string;
  fraudWarningId?: string;
  orderId?: string | null;
};

/**
 * radar.early_fraud_warning.created on the platform Account webhook.
 * Match charge → order via payment_intent / charge id. Never auto-refund.
 */
export async function handleEarlyFraudWarning(
  supabase: SupabaseClient,
  efw: Stripe.Radar.EarlyFraudWarning,
): Promise<FraudWarningResult> {
  const stripeEfwId = efw.id;
  const chargeId =
    typeof efw.charge === "string" ? efw.charge : efw.charge?.id ?? "";

  const { data: existing } = await supabase
    .from("fraud_warnings")
    .select("id, order_id")
    .eq("stripe_efw_id", stripeEfwId)
    .maybeSingle();
  if (existing) {
    return {
      handled: true,
      action: "already_exists",
      fraudWarningId: existing.id as string,
      orderId: (existing.order_id as string | null) ?? null,
    };
  }

  if (!chargeId) {
    console.info("[fraud-warning] missing charge id", { stripeEfwId });
    return { handled: true, action: "no_charge" };
  }

  let paymentIntentId: string | null = null;
  try {
    const charge = await getStripe().charges.retrieve(chargeId);
    paymentIntentId =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id ?? null;
  } catch (caught) {
    console.warn("[fraud-warning] charge retrieve failed", {
      chargeId,
      error: caught instanceof Error ? caught.message : String(caught),
    });
  }

  let orderId: string | null = null;
  let businessId: string | null = null;
  let orderRef = "unknown";
  let orderStatus: string | null = null;

  if (paymentIntentId) {
    const { data: byPi } = await supabase
      .from("orders")
      .select("id, business_id, order_ref, status")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .is("deleted_at", null)
      .maybeSingle();
    if (byPi) {
      orderId = byPi.id as string;
      businessId = byPi.business_id as string;
      orderRef = byPi.order_ref as string;
      orderStatus = byPi.status as string;
    }
  }

  if (!orderId) {
    console.info("[fraud-warning] unmatched order — ignore", {
      stripeEfwId,
      chargeId,
      paymentIntentId,
    });
    return { handled: true, action: "unmatched_ignore" };
  }

  const actionable = Boolean(efw.actionable);
  const now = new Date().toISOString();
  const { data: inserted, error } = await supabase
    .from("fraud_warnings")
    .insert({
      business_id: businessId,
      order_id: orderId,
      stripe_efw_id: stripeEfwId,
      stripe_charge_id: chargeId,
      actionable,
      status: "open",
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      return { handled: true, action: "already_exists", orderId };
    }
    throw new Error(error.message);
  }

  const fraudWarningId = inserted.id as string;

  // Alert seller only when actionable and order not already refunded.
  const alreadyRefunded =
    orderStatus === "REFUNDED" ||
    orderStatus === "PARTIALLY_REFUNDED" ||
    orderStatus === "REFUND_PENDING";

  if (actionable && !alreadyRefunded && businessId) {
    await notifySellerFraudWarning({
      supabase,
      businessId,
      orderRef,
    });
    await supabase
      .from("fraud_warnings")
      .update({ seller_notified_at: now, updated_at: now })
      .eq("id", fraudWarningId)
      .is("seller_notified_at", null);
  }

  return {
    handled: true,
    action: actionable ? "created_actionable" : "created_info",
    fraudWarningId,
    orderId,
  };
}

export async function listOpenActionableFraudWarnings(
  supabase: SupabaseClient,
  businessId: string,
): Promise<
  { id: string; orderId: string | null; orderRef: string | null; actionable: boolean }[]
> {
  const { data, error } = await supabase
    .from("fraud_warnings")
    .select("id, order_id, actionable, orders(order_ref)")
    .eq("business_id", businessId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const orders = row.orders as
      | { order_ref: string }
      | { order_ref: string }[]
      | null;
    const ref = Array.isArray(orders)
      ? orders[0]?.order_ref
      : orders?.order_ref;
    return {
      id: row.id as string,
      orderId: (row.order_id as string | null) ?? null,
      orderRef: ref ?? null,
      actionable: Boolean(row.actionable),
    };
  });
}
