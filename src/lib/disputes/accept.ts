import type { SupabaseClient } from "@supabase/supabase-js";

import { getStripe } from "@/lib/stripe/client";

/**
 * Seller accepts liability: Stripe disputes.close → dispute becomes lost.
 * Evidence form must be locked afterwards (accepted_at + evidence not_needed).
 */
export async function acceptDispute(params: {
  supabase: SupabaseClient;
  disputeId: string;
  businessId: string;
}): Promise<{ ok: true; stripeDisputeId: string } | { ok: false; error: string }> {
  const { data: dispute, error } = await params.supabase
    .from("disputes")
    .select(
      "id, stripe_dispute_id, status, closed_at, evidence_status, accepted_at, evidence_submitted_at",
    )
    .eq("id", params.disputeId)
    .eq("business_id", params.businessId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!dispute) return { ok: false, error: "Dispute not found" };
  if (dispute.closed_at || dispute.accepted_at) {
    return { ok: false, error: "Dispute is already closed or accepted" };
  }
  if (dispute.evidence_status === "submitted" || dispute.evidence_submitted_at) {
    return {
      ok: false,
      error: "Evidence already submitted — you cannot accept after contesting",
    };
  }

  const stripeDisputeId = dispute.stripe_dispute_id as string;
  try {
    await getStripe().disputes.close(stripeDisputeId, undefined, {
      idempotencyKey: `dispute-accept:${params.disputeId}`,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, error: message };
  }

  const now = new Date().toISOString();
  await params.supabase
    .from("disputes")
    .update({
      accepted_at: now,
      evidence_status: "not_needed",
      updated_at: now,
    })
    .eq("id", params.disputeId)
    .eq("business_id", params.businessId);

  return { ok: true, stripeDisputeId };
}
