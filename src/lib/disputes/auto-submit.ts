import type { SupabaseClient } from "@supabase/supabase-js";

import { getDisputeAutoSubmitMinPence } from "@/lib/disputes/constants";

export type AutoSubmitEligibility = {
  eligible: boolean;
  reason:
    | "ok"
    | "accepted"
    | "already_submitted"
    | "below_minimum"
    | "missing_core_evidence"
    | "no_order";
  hasOrder: boolean;
  hasPayment: boolean;
  hasAddress: boolean;
  hasDeliveryOrTracking: boolean;
};

/**
 * Auto-submit only when: not accepted, not already submitted, amount ≥ min,
 * and core evidence pack fields are present (order, payment, address,
 * delivery or tracking where applicable).
 */
export async function evaluateAutoSubmitEligibility(
  supabase: SupabaseClient,
  disputeId: string,
): Promise<AutoSubmitEligibility> {
  const { data: dispute, error } = await supabase
    .from("disputes")
    .select(
      "id, amount_pence, accepted_at, evidence_status, evidence_submitted_at, order_id, business_id",
    )
    .eq("id", disputeId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!dispute) {
    return {
      eligible: false,
      reason: "no_order",
      hasOrder: false,
      hasPayment: false,
      hasAddress: false,
      hasDeliveryOrTracking: false,
    };
  }

  if (dispute.accepted_at) {
    return {
      eligible: false,
      reason: "accepted",
      hasOrder: Boolean(dispute.order_id),
      hasPayment: false,
      hasAddress: false,
      hasDeliveryOrTracking: false,
    };
  }

  if (
    dispute.evidence_status === "submitted" ||
    dispute.evidence_submitted_at
  ) {
    return {
      eligible: false,
      reason: "already_submitted",
      hasOrder: Boolean(dispute.order_id),
      hasPayment: false,
      hasAddress: false,
      hasDeliveryOrTracking: false,
    };
  }

  const amount = (dispute.amount_pence as number) ?? 0;
  if (amount < getDisputeAutoSubmitMinPence()) {
    return {
      eligible: false,
      reason: "below_minimum",
      hasOrder: Boolean(dispute.order_id),
      hasPayment: false,
      hasAddress: false,
      hasDeliveryOrTracking: false,
    };
  }

  if (!dispute.order_id) {
    return {
      eligible: false,
      reason: "no_order",
      hasOrder: false,
      hasPayment: false,
      hasAddress: false,
      hasDeliveryOrTracking: false,
    };
  }

  const { data: order } = await supabase
    .from("orders")
    .select(
      "id, stripe_payment_intent_id, shipping_address, delivered_at, dispatch_tracking_number, tracking_status",
    )
    .eq("id", dispute.order_id)
    .eq("business_id", dispute.business_id)
    .maybeSingle();

  const hasOrder = Boolean(order);
  const hasPayment = Boolean(order?.stripe_payment_intent_id);
  const address = order?.shipping_address;
  const hasAddress =
    Boolean(address) &&
    typeof address === "object" &&
    Object.values(address as Record<string, unknown>).some(
      (v) => typeof v === "string" && v.trim().length > 0,
    );
  const hasDeliveryOrTracking = Boolean(
    order?.delivered_at ||
      (typeof order?.dispatch_tracking_number === "string" &&
        order.dispatch_tracking_number.trim()) ||
      (typeof order?.tracking_status === "string" &&
        order.tracking_status.trim() &&
        order.tracking_status !== "UNKNOWN"),
  );

  if (!hasOrder || !hasPayment || !hasAddress || !hasDeliveryOrTracking) {
    return {
      eligible: false,
      reason: "missing_core_evidence",
      hasOrder,
      hasPayment,
      hasAddress,
      hasDeliveryOrTracking,
    };
  }

  return {
    eligible: true,
    reason: "ok",
    hasOrder,
    hasPayment,
    hasAddress,
    hasDeliveryOrTracking,
  };
}
