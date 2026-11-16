import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { getStripe } from "@/lib/stripe/client";

export type RecoveryResult = {
  disputeId: string;
  alreadyRecovered: boolean;
  recoveredPence: number;
  unrecoveredPence: number;
  transferId: string | null;
  reversalId: string | null;
  reason?: string;
};

/**
 * Reverse the destination-charge transfer for a LOST dispute.
 * Stripe does NOT auto-reverse for destination charges — we must do it.
 * Never reverse more than the remaining unreversed transfer amount.
 * Idempotent: second call is a no-op when stripe_transfer_reversal_id is set.
 */
export async function recoverLostDisputeFunds(
  supabase: SupabaseClient,
  disputeId: string,
): Promise<RecoveryResult> {
  const { data: dispute, error } = await supabase
    .from("disputes")
    .select(
      "id, amount_pence, stripe_fee_pence, stripe_charge_id, stripe_transfer_id, stripe_transfer_reversal_id, recovered_pence, unrecovered_pence, outcome, recovery_attempted_at",
    )
    .eq("id", disputeId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!dispute) throw new Error("DISPUTE_NOT_FOUND");

  if (dispute.outcome !== "lost") {
    return {
      disputeId,
      alreadyRecovered: false,
      recoveredPence: dispute.recovered_pence as number,
      unrecoveredPence: dispute.unrecovered_pence as number,
      transferId: (dispute.stripe_transfer_id as string | null) ?? null,
      reversalId: (dispute.stripe_transfer_reversal_id as string | null) ?? null,
      reason: "not_lost",
    };
  }

  if (dispute.stripe_transfer_reversal_id) {
    return {
      disputeId,
      alreadyRecovered: true,
      recoveredPence: dispute.recovered_pence as number,
      unrecoveredPence: dispute.unrecovered_pence as number,
      transferId: (dispute.stripe_transfer_id as string | null) ?? null,
      reversalId: dispute.stripe_transfer_reversal_id as string,
      reason: "already_reversed",
    };
  }

  const stripe = getStripe();
  let transferId = (dispute.stripe_transfer_id as string | null) ?? null;

  if (!transferId && dispute.stripe_charge_id) {
    try {
      const charge = await stripe.charges.retrieve(
        dispute.stripe_charge_id as string,
      );
      transferId =
        typeof charge.transfer === "string"
          ? charge.transfer
          : charge.transfer?.id ?? null;
    } catch {
      transferId = null;
    }
  }

  const disputedAmount = dispute.amount_pence as number;
  const fee = (dispute.stripe_fee_pence as number | null) ?? 0;
  const targetRecover = disputedAmount + Math.max(0, fee);

  if (!transferId) {
    await supabase
      .from("disputes")
      .update({
        recovered_pence: 0,
        unrecovered_pence: targetRecover,
        recovery_attempted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", disputeId)
      .is("stripe_transfer_reversal_id", null);

    return {
      disputeId,
      alreadyRecovered: false,
      recoveredPence: 0,
      unrecoveredPence: targetRecover,
      transferId: null,
      reversalId: null,
      reason: "no_transfer",
    };
  }

  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.retrieve(transferId);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await supabase
      .from("disputes")
      .update({
        recovered_pence: 0,
        unrecovered_pence: targetRecover,
        stripe_transfer_id: transferId,
        recovery_attempted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", disputeId)
      .is("stripe_transfer_reversal_id", null);

    return {
      disputeId,
      alreadyRecovered: false,
      recoveredPence: 0,
      unrecoveredPence: targetRecover,
      transferId,
      reversalId: null,
      reason: `transfer_retrieve_failed:${message}`,
    };
  }

  const alreadyReversed = transfer.reversed
    ? transfer.amount
    : (transfer.amount_reversed ?? 0);
  const remaining = Math.max(0, transfer.amount - alreadyReversed);

  if (remaining <= 0) {
    // Transfer already fully reversed (e.g. prior refund with reverse_transfer).
    await supabase
      .from("disputes")
      .update({
        stripe_transfer_id: transferId,
        recovered_pence: 0,
        unrecovered_pence: targetRecover,
        recovery_attempted_at: new Date().toISOString(),
        // Mark a sentinel so we do not retry indefinitely.
        stripe_transfer_reversal_id:
          transfer.reversals?.data?.[0]?.id ?? `already_fully_reversed:${transferId}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", disputeId)
      .is("stripe_transfer_reversal_id", null);

    return {
      disputeId,
      alreadyRecovered: true,
      recoveredPence: 0,
      unrecoveredPence: targetRecover,
      transferId,
      reversalId: transfer.reversals?.data?.[0]?.id ?? null,
      reason: "transfer_already_fully_reversed",
    };
  }

  const reverseAmount = Math.min(remaining, targetRecover);

  try {
    const reversal = await stripe.transfers.createReversal(transferId, {
      amount: reverseAmount,
      description: `TradeFlow dispute recovery ${disputeId}`,
      metadata: {
        dispute_id: disputeId,
        purpose: "lost_dispute_recovery",
      },
    });

    const recovered = reverseAmount;
    const unrecovered = Math.max(0, targetRecover - recovered);

    await supabase
      .from("disputes")
      .update({
        stripe_transfer_id: transferId,
        stripe_transfer_reversal_id: reversal.id,
        recovered_pence: recovered,
        unrecovered_pence: unrecovered,
        recovery_attempted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", disputeId)
      .is("stripe_transfer_reversal_id", null);

    return {
      disputeId,
      alreadyRecovered: false,
      recoveredPence: recovered,
      unrecoveredPence: unrecovered,
      transferId,
      reversalId: reversal.id,
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error("[disputes] transfer reversal failed", {
      disputeId,
      transferId,
      error: message,
    });

    await supabase
      .from("disputes")
      .update({
        stripe_transfer_id: transferId,
        recovered_pence: 0,
        unrecovered_pence: targetRecover,
        recovery_attempted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", disputeId)
      .is("stripe_transfer_reversal_id", null);

    return {
      disputeId,
      alreadyRecovered: false,
      recoveredPence: 0,
      unrecoveredPence: targetRecover,
      transferId,
      reversalId: null,
      reason: `reversal_failed:${message}`,
    };
  }
}

/** Extract dispute fee (positive) from Stripe dispute balance transactions. */
export function extractDisputeFeePence(dispute: Stripe.Dispute): number | null {
  const txs = dispute.balance_transactions ?? [];
  let fee = 0;
  for (const tx of txs) {
    if (typeof tx === "string") continue;
    // Dispute fee appears as fee on the withdrawal balance transaction.
    if (typeof tx.fee === "number" && tx.fee > 0) {
      fee += tx.fee;
    }
  }
  return fee > 0 ? fee : null;
}
