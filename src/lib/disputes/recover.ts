import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { getDisputeFeePence } from "@/lib/disputes/constants";
import {
  extractDisputeFeePence,
  resolveDisputeFees,
} from "@/lib/disputes/fees";
import { getStripe } from "@/lib/stripe/client";

export { extractDisputeFeePence };

export type RecoveryResult = {
  disputeId: string;
  alreadyRecovered: boolean;
  recoveredPence: number;
  unrecoveredPence: number;
  transferId: string | null;
  reversalId: string | null;
  reason?: string;
};

export type FullRecoveryResult = {
  disputeId: string;
  recoveryStatus: string;
  owedPence: number;
  recoveredViaReversalPence: number;
  recoveredViaAccountDebitPence: number;
  recoveredViaInvoicePence: number;
  unrecoveredPence: number;
  invoiceId: string | null;
  notes: string[];
};

function idemKey(disputeId: string, step: string): string {
  return `dispute-recovery:${disputeId}:${step}`;
}

function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/**
 * Reverse the destination-charge transfer for a LOST dispute (Step 21).
 * Idempotent: second call is a no-op when stripe_transfer_reversal_id is set.
 *
 * Fee liability (seller):
 * - Accepted (not contested): received fee + unrecovered amount.
 * - Contested and lost: received + counter fees + unrecovered amount.
 * - Contested and won / withdrawn: seller owes £0 — Copalla absorbs the
 *   received fee (Stripe returns the counter fee on a win).
 * Copalla's application fee and Stripe's original processing fee are NEVER
 * charged back to the seller — we absorb them.
 */
export async function recoverLostDisputeFunds(
  supabase: SupabaseClient,
  disputeId: string,
  options?: { targetRecoverPence?: number },
): Promise<RecoveryResult> {
  const { data: dispute, error } = await supabase
    .from("disputes")
    .select(
      "id, amount_pence, stripe_fee_pence, fee_pence, stripe_charge_id, stripe_transfer_id, stripe_transfer_reversal_id, recovered_pence, unrecovered_pence, recovered_via_reversal_pence, outcome, recovery_attempted_at",
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
      recoveredPence:
        (dispute.recovered_via_reversal_pence as number | null) ??
        (dispute.recovered_pence as number),
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

  const fee =
    options?.targetRecoverPence != null
      ? 0
      : (dispute.fee_pence as number | null) ?? getDisputeFeePence();
  const disputedAmount = dispute.amount_pence as number;
  const targetRecover =
    options?.targetRecoverPence ?? disputedAmount + Math.max(0, fee);

  if (!transferId) {
    await supabase
      .from("disputes")
      .update({
        recovered_pence: 0,
        recovered_via_reversal_pence: 0,
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
        recovered_via_reversal_pence: 0,
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
    await supabase
      .from("disputes")
      .update({
        stripe_transfer_id: transferId,
        recovered_pence: 0,
        recovered_via_reversal_pence: 0,
        unrecovered_pence: targetRecover,
        recovery_attempted_at: new Date().toISOString(),
        stripe_transfer_reversal_id:
          transfer.reversals?.data?.[0]?.id ??
          `already_fully_reversed:${transferId}`,
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
    const reversal = await stripe.transfers.createReversal(
      transferId,
      {
        amount: reverseAmount,
        description: `TradeFlow dispute recovery ${disputeId}`,
        metadata: {
          dispute_id: disputeId,
          purpose: "lost_dispute_recovery",
        },
      },
      { idempotencyKey: idemKey(disputeId, "reversal") },
    );

    const recovered = reverseAmount;
    const unrecovered = Math.max(0, targetRecover - recovered);

    await supabase
      .from("disputes")
      .update({
        stripe_transfer_id: transferId,
        stripe_transfer_reversal_id: reversal.id,
        recovered_pence: recovered,
        recovered_via_reversal_pence: recovered,
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
        recovered_via_reversal_pence: 0,
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

async function accountDebitConnected(
  connectedAccountId: string,
  amountPence: number,
  currency: string,
  disputeId: string,
): Promise<{ ok: true; chargeId: string; amount: number } | { ok: false; reason: string }> {
  if (amountPence <= 0) {
    return { ok: true, chargeId: "", amount: 0 };
  }
  try {
    // Account debits: Charge with source = connected account id.
    // Supported for Express when the platform is liable for negative balances
    // (destination-charge platforms). See docs.stripe.com/connect/account-debits.
    const charge = await getStripe().charges.create(
      {
        amount: amountPence,
        currency: currency.toLowerCase(),
        source: connectedAccountId,
        description: `TradeFlow dispute recovery ${disputeId}`,
        metadata: {
          dispute_id: disputeId,
          purpose: "lost_dispute_account_debit",
        },
      },
      { idempotencyKey: idemKey(disputeId, "account_debit") },
    );
    return { ok: true, chargeId: charge.id, amount: charge.amount };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, reason: message };
  }
}

async function invoiceSellerRemainder(params: {
  supabase: SupabaseClient;
  businessId: string;
  disputeId: string;
  orderRef: string;
  amountPence: number;
  currency: string;
  existingInvoiceId: string | null;
}): Promise<
  | { ok: true; invoiceId: string; paid: boolean; amount: number }
  | { ok: false; reason: string; invoiceId: string | null }
> {
  const { amountPence } = params;
  if (amountPence <= 0) {
    return {
      ok: true,
      invoiceId: params.existingInvoiceId ?? "",
      paid: true,
      amount: 0,
    };
  }

  const { data: business, error } = await params.supabase
    .from("businesses")
    .select("id, stripe_customer_id")
    .eq("id", params.businessId)
    .maybeSingle();
  if (error) return { ok: false, reason: error.message, invoiceId: null };
  const customerId = business?.stripe_customer_id as string | null;
  if (!customerId) {
    return { ok: false, reason: "no_stripe_customer", invoiceId: null };
  }

  const stripe = getStripe();

  if (params.existingInvoiceId) {
    try {
      const existing = await stripe.invoices.retrieve(params.existingInvoiceId);
      if (existing.status === "paid") {
        return {
          ok: true,
          invoiceId: existing.id,
          paid: true,
          amount: existing.amount_paid ?? amountPence,
        };
      }
      if (existing.status === "open" || existing.status === "draft") {
        const paid =
          existing.status === "draft"
            ? await stripe.invoices.finalizeInvoice(existing.id).then(async (inv) => {
                if (inv.status === "paid") return inv;
                return stripe.invoices.pay(inv.id, {
                  // default PM on customer
                });
              })
            : await stripe.invoices.pay(existing.id);
        return {
          ok: true,
          invoiceId: paid.id,
          paid: paid.status === "paid",
          amount: paid.amount_paid ?? amountPence,
        };
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        ok: false,
        reason: `existing_invoice:${message}`,
        invoiceId: params.existingInvoiceId,
      };
    }
  }

  try {
    await stripe.invoiceItems.create(
      {
        customer: customerId,
        amount: amountPence,
        currency: params.currency.toLowerCase(),
        description: `Dispute fee and unrecovered chargeback for order ${params.orderRef}`,
        metadata: {
          dispute_id: params.disputeId,
          business_id: params.businessId,
          purpose: "lost_dispute_recovery",
        },
      },
      { idempotencyKey: idemKey(params.disputeId, "invoice_item") },
    );

    const invoice = await stripe.invoices.create(
      {
        customer: customerId,
        collection_method: "charge_automatically",
        auto_advance: true,
        metadata: {
          dispute_id: params.disputeId,
          business_id: params.businessId,
          purpose: "lost_dispute_recovery",
        },
      },
      { idempotencyKey: idemKey(params.disputeId, "invoice") },
    );

    const finalized = await stripe.invoices.finalizeInvoice(
      invoice.id,
      {},
      { idempotencyKey: idemKey(params.disputeId, "invoice_finalize") },
    );

    if (finalized.status === "paid") {
      return {
        ok: true,
        invoiceId: finalized.id,
        paid: true,
        amount: finalized.amount_paid ?? amountPence,
      };
    }

    try {
      const paid = await stripe.invoices.pay(
        finalized.id,
        {},
        { idempotencyKey: idemKey(params.disputeId, "invoice_pay") },
      );
      return {
        ok: true,
        invoiceId: paid.id,
        paid: paid.status === "paid",
        amount: paid.amount_paid ?? amountPence,
      };
    } catch (payErr) {
      const message = payErr instanceof Error ? payErr.message : String(payErr);
      return {
        ok: false,
        reason: `invoice_pay:${message}`,
        invoiceId: finalized.id,
      };
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, reason: `invoice_create:${message}`, invoiceId: null };
  }
}

async function setBusinessDisputeHold(
  supabase: SupabaseClient,
  businessId: string,
  owedPence: number,
  hold: boolean,
): Promise<void> {
  await supabase
    .from("businesses")
    .update({
      dispute_balance_hold: hold,
      dispute_balance_owed_pence: Math.max(0, owedPence),
      updated_at: new Date().toISOString(),
    })
    .eq("id", businessId);
}

/**
 * Full recovery sequence after a dispute closes as lost (or seller accepts).
 * Steps (stop when owed covered): transfer reversal → account debit → invoice.
 * Won/withdrawn: caller should use markRecoveryNotNeeded instead.
 */
export async function runFullDisputeRecovery(
  supabase: SupabaseClient,
  disputeId: string,
): Promise<FullRecoveryResult> {
  const { data: dispute, error } = await supabase
    .from("disputes")
    .select(
      "id, business_id, order_id, amount_pence, currency, outcome, fee_pence, received_fee_pence, counter_fee_pence, fee_source, contested, accepted_at, evidence_status, evidence_submitted_at, stripe_dispute_id, recovery_status, recovered_via_reversal_pence, recovered_via_account_debit_pence, recovered_via_invoice_pence, unrecovered_pence, recovery_invoice_id, stripe_transfer_reversal_id, recovery_notes, recovery_charge_notified_at",
    )
    .eq("id", disputeId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!dispute) throw new Error("DISPUTE_NOT_FOUND");

  const notes: string[] = [];
  const appendNote = (line: string) => {
    notes.push(line);
  };

  if (dispute.outcome !== "lost") {
    return markRecoveryNotNeeded(supabase, disputeId, "outcome_not_lost");
  }

  if (
    dispute.recovery_status === "recovered" ||
    dispute.recovery_status === "not_needed"
  ) {
    return {
      disputeId,
      recoveryStatus: dispute.recovery_status as string,
      owedPence: 0,
      recoveredViaReversalPence: dispute.recovered_via_reversal_pence as number,
      recoveredViaAccountDebitPence:
        dispute.recovered_via_account_debit_pence as number,
      recoveredViaInvoicePence: dispute.recovered_via_invoice_pence as number,
      unrecoveredPence: dispute.unrecovered_pence as number,
      invoiceId: (dispute.recovery_invoice_id as string | null) ?? null,
      notes: ["already_terminal"],
    };
  }

  const contested =
    Boolean(dispute.contested) ||
    dispute.evidence_status === "submitted" ||
    Boolean(dispute.evidence_submitted_at);

  // Prefer live Stripe fees when the dispute object is available.
  let stripeDispute: import("stripe").default.Dispute | null = null;
  if (dispute.stripe_dispute_id) {
    try {
      stripeDispute = await getStripe().disputes.retrieve(
        dispute.stripe_dispute_id as string,
        { expand: ["balance_transactions"] },
      );
    } catch {
      stripeDispute = null;
    }
  }

  const fees = resolveDisputeFees({
    stripeDispute,
    contested,
    outcome: "lost",
    storedReceived: dispute.received_fee_pence as number | null,
    storedCounter: dispute.counter_fee_pence as number | null,
    storedSource: dispute.fee_source as
      | "stripe_balance_transactions"
      | "constants"
      | null,
  });

  // Seller owes disputed amount + applicable dispute fees only.
  // Copalla absorbs application fee + Stripe processing fee.
  const feePence = fees.sellerFeePence;
  const owedTotal = (dispute.amount_pence as number) + feePence;
  appendNote(
    `fees:received=${fees.receivedFeePence};counter=${fees.counterFeePence};seller=${feePence};source=${fees.feeSource};contested=${contested}`,
  );
  const currency = ((dispute.currency as string) || "gbp").toLowerCase();
  const businessId = dispute.business_id as string;

  let orderRef = "unknown";
  if (dispute.order_id) {
    const { data: order } = await supabase
      .from("orders")
      .select("order_ref")
      .eq("id", dispute.order_id)
      .maybeSingle();
    orderRef = (order?.order_ref as string | undefined) ?? "unknown";
  }

  const now = new Date().toISOString();
  await supabase
    .from("disputes")
    .update({
      recovery_status: "pending",
      contested,
      fee_pence: feePence,
      received_fee_pence: fees.receivedFeePence,
      counter_fee_pence: fees.counterFeePence,
      fee_source: fees.feeSource,
      stripe_fee_pence:
        fees.stripeTotalFeePence ??
        fees.receivedFeePence + fees.counterFeePence,
      recovery_updated_at: now,
      updated_at: now,
    })
    .eq("id", disputeId);

  // --- Step 1: transfer reversal ---
  const reversal = await recoverLostDisputeFunds(supabase, disputeId, {
    targetRecoverPence: owedTotal,
  });
  let viaReversal = Math.max(0, reversal.recoveredPence);
  appendNote(
    `reversal:${viaReversal}${reversal.reason ? ` (${reversal.reason})` : ""}`,
  );

  let remaining = Math.max(0, owedTotal - viaReversal);
  let viaDebit =
    (dispute.recovered_via_account_debit_pence as number | null) ?? 0;
  let viaInvoice =
    (dispute.recovered_via_invoice_pence as number | null) ?? 0;
  let invoiceId = (dispute.recovery_invoice_id as string | null) ?? null;

  // --- Step 2: account debit (Express + platform-liable NB supported) ---
  if (remaining > 0 && viaDebit <= 0) {
    const { data: biz } = await supabase
      .from("businesses")
      .select("stripe_connected_account_id")
      .eq("id", businessId)
      .maybeSingle();
    const connectedId = biz?.stripe_connected_account_id as string | null;
    if (connectedId) {
      const debit = await accountDebitConnected(
        connectedId,
        remaining,
        currency,
        disputeId,
      );
      if (debit.ok && debit.amount > 0) {
        viaDebit = debit.amount;
        remaining = Math.max(0, remaining - viaDebit);
        appendNote(`account_debit:${viaDebit} (${debit.chargeId})`);
      } else if (!debit.ok) {
        appendNote(`account_debit_failed:${debit.reason}`);
      } else {
        appendNote("account_debit:skipped_zero");
      }
    } else {
      appendNote("account_debit_skipped:no_connected_account");
    }
  } else if (viaDebit > 0) {
    remaining = Math.max(0, remaining - viaDebit);
    appendNote(`account_debit:already:${viaDebit}`);
  }

  // --- Step 3: invoice remainder to seller card on file ---
  if (remaining > 0) {
    const inv = await invoiceSellerRemainder({
      supabase,
      businessId,
      disputeId,
      orderRef,
      amountPence: remaining,
      currency,
      existingInvoiceId: invoiceId,
    });
    if (inv.ok) {
      invoiceId = inv.invoiceId || invoiceId;
      if (inv.paid && inv.amount > 0) {
        viaInvoice = inv.amount;
        remaining = Math.max(0, remaining - viaInvoice);
        appendNote(`invoice_paid:${viaInvoice} (${invoiceId})`);
      } else {
        invoiceId = inv.invoiceId || invoiceId;
        appendNote(
          inv.paid
            ? `invoice_paid_zero:${invoiceId}`
            : `invoice_open_unpaid:${invoiceId}`,
        );
      }
    } else {
      invoiceId = inv.invoiceId ?? invoiceId;
      appendNote(`invoice_failed:${inv.reason}`);
    }
  }

  const recoveredTotal = viaReversal + viaDebit + viaInvoice;
  const unrecovered = Math.max(0, owedTotal - recoveredTotal);
  // Spec: if anything remains after invoice attempt (or invoice never paid),
  // status is unpaid (hold). partial is reserved for invoice.paid that still
  // leaves a shortfall after a successful card charge.
  let recoveryStatus: string;
  if (unrecovered <= 0) {
    recoveryStatus = "recovered";
  } else if (remaining > 0) {
    recoveryStatus = "unpaid";
  } else if (recoveredTotal > 0) {
    recoveryStatus = "partial";
  } else {
    recoveryStatus = "unpaid";
  }

  const recoveryNotes = notes.join("; ").slice(0, 2000);
  await supabase
    .from("disputes")
    .update({
      recovery_status: recoveryStatus,
      fee_pence: feePence,
      recovered_via_reversal_pence: viaReversal,
      recovered_via_account_debit_pence: viaDebit,
      recovered_via_invoice_pence: viaInvoice,
      recovered_pence: recoveredTotal,
      unrecovered_pence: unrecovered,
      recovery_invoice_id: invoiceId,
      recovery_notes: recoveryNotes,
      recovery_updated_at: new Date().toISOString(),
      recovery_attempted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", disputeId);

  if (recoveryStatus === "unpaid" || recoveryStatus === "partial") {
    if (unrecovered > 0) {
      await setBusinessDisputeHold(supabase, businessId, unrecovered, true);
    }
  } else if (recoveryStatus === "recovered") {
    await clearHoldIfNoUnpaid(supabase, businessId, disputeId);
  }

  // Notify seller of recovery state (recovered / partial / unpaid).
  try {
    const { notifySellerDisputeCharge } = await import("@/lib/disputes/notify");
    await notifySellerDisputeCharge({
      supabase,
      businessId,
      orderRef,
      recoveryStatus,
      takenPence: recoveredTotal,
      owedPence: unrecovered,
      viaReversalPence: viaReversal,
      viaDebitPence: viaDebit,
      viaInvoicePence: viaInvoice,
    });
    await supabase
      .from("disputes")
      .update({
        recovery_charge_notified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", disputeId)
      .is("recovery_charge_notified_at", null);
  } catch (caught) {
    console.error("[disputes] recovery notify failed", {
      disputeId,
      error: caught instanceof Error ? caught.message : String(caught),
    });
  }

  return {
    disputeId,
    recoveryStatus,
    owedPence: owedTotal,
    recoveredViaReversalPence: viaReversal,
    recoveredViaAccountDebitPence: viaDebit,
    recoveredViaInvoicePence: viaInvoice,
    unrecoveredPence: unrecovered,
    invoiceId,
    notes,
  };
}

export async function markRecoveryNotNeeded(
  supabase: SupabaseClient,
  disputeId: string,
  reason = "won_or_withdrawn",
): Promise<FullRecoveryResult> {
  // Won / withdrawn: seller owes £0. Copalla absorbs the Stripe received fee.
  const now = new Date().toISOString();
  await supabase
    .from("disputes")
    .update({
      recovery_status: "not_needed",
      fee_pence: 0,
      unrecovered_pence: 0,
      recovery_notes: `${reason};copalla_absorbs_received_fee`,
      recovery_updated_at: now,
      updated_at: now,
    })
    .eq("id", disputeId)
    .or("recovery_status.is.null,recovery_status.eq.pending");

  return {
    disputeId,
    recoveryStatus: "not_needed",
    owedPence: 0,
    recoveredViaReversalPence: 0,
    recoveredViaAccountDebitPence: 0,
    recoveredViaInvoicePence: 0,
    unrecoveredPence: 0,
    invoiceId: null,
    notes: [reason],
  };
}

async function clearHoldIfNoUnpaid(
  supabase: SupabaseClient,
  businessId: string,
  exceptDisputeId?: string,
): Promise<void> {
  let q = supabase
    .from("disputes")
    .select("id, unrecovered_pence")
    .eq("business_id", businessId)
    .eq("recovery_status", "unpaid");
  if (exceptDisputeId) {
    q = q.neq("id", exceptDisputeId);
  }
  const { data } = await q;
  const stillOwed = (data ?? []).reduce(
    (sum, row) => sum + Math.max(0, (row.unrecovered_pence as number) ?? 0),
    0,
  );
  // Also count partial with unrecovered.
  const { data: partials } = await supabase
    .from("disputes")
    .select("id, unrecovered_pence")
    .eq("business_id", businessId)
    .eq("recovery_status", "partial")
    .gt("unrecovered_pence", 0);
  const partialOwed = (partials ?? [])
    .filter((r) => r.id !== exceptDisputeId)
    .reduce(
      (sum, row) => sum + Math.max(0, (row.unrecovered_pence as number) ?? 0),
      0,
    );
  const total = stillOwed + partialOwed;
  await setBusinessDisputeHold(supabase, businessId, total, total > 0);
}

/**
 * invoice.paid / invoice.payment_failed for dispute recovery invoices.
 */
export async function handleDisputeRecoveryInvoice(
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
  eventType: "invoice.paid" | "invoice.payment_failed",
): Promise<{ handled: boolean; action: string; disputeId?: string }> {
  const disputeId = invoice.metadata?.dispute_id;
  const purpose = invoice.metadata?.purpose;
  if (!disputeId || purpose !== "lost_dispute_recovery") {
    return { handled: false, action: "not_dispute_recovery_invoice" };
  }

  const { data: dispute, error } = await supabase
    .from("disputes")
    .select(
      "id, business_id, amount_pence, fee_pence, recovered_via_reversal_pence, recovered_via_account_debit_pence, recovered_via_invoice_pence, unrecovered_pence, recovery_status, order_id",
    )
    .eq("id", disputeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!dispute) {
    return { handled: true, action: "dispute_missing", disputeId };
  }

  if (eventType === "invoice.paid") {
    const fee = (dispute.fee_pence as number | null) ?? getDisputeFeePence();
    const owedTotal = (dispute.amount_pence as number) + fee;
    const viaReversal = dispute.recovered_via_reversal_pence as number;
    const viaDebit = dispute.recovered_via_account_debit_pence as number;
    const viaInvoice = invoice.amount_paid ?? 0;
    // Ignore empty/zero paid invoices — they must not flip unpaid → partial.
    if (viaInvoice <= 0) {
      return { handled: true, action: "ignored_zero_invoice_paid", disputeId };
    }
    const recoveredTotal = viaReversal + viaDebit + viaInvoice;
    const unrecovered = Math.max(0, owedTotal - recoveredTotal);
    const nextStatus = unrecovered <= 0 ? "recovered" : "partial";

    await supabase
      .from("disputes")
      .update({
        recovery_status: nextStatus,
        recovered_via_invoice_pence: viaInvoice,
        recovered_pence: recoveredTotal,
        unrecovered_pence: unrecovered,
        recovery_invoice_id: invoice.id,
        recovery_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        recovery_notes: `invoice.paid:${viaInvoice}`,
      })
      .eq("id", disputeId);

    await clearHoldIfNoUnpaid(supabase, dispute.business_id as string, disputeId);
    if (unrecovered <= 0) {
      await setBusinessDisputeHold(
        supabase,
        dispute.business_id as string,
        0,
        false,
      );
    }

    try {
      let orderRef = "unknown";
      if (dispute.order_id) {
        const { data: order } = await supabase
          .from("orders")
          .select("order_ref")
          .eq("id", dispute.order_id)
          .maybeSingle();
        orderRef = (order?.order_ref as string) ?? "unknown";
      }
      const { notifySellerDisputeCharge } = await import("@/lib/disputes/notify");
      await notifySellerDisputeCharge({
        supabase,
        businessId: dispute.business_id as string,
        orderRef,
        recoveryStatus: unrecovered <= 0 ? "recovered" : "partial",
        takenPence: recoveredTotal,
        owedPence: unrecovered,
        viaReversalPence: viaReversal,
        viaDebitPence: viaDebit,
        viaInvoicePence: viaInvoice,
      });
    } catch {
      // non-fatal
    }

    return { handled: true, action: "invoice_paid_cleared", disputeId };
  }

  // payment_failed
  const fee = (dispute.fee_pence as number | null) ?? getDisputeFeePence();
  const owedTotal = (dispute.amount_pence as number) + fee;
  const viaReversal = dispute.recovered_via_reversal_pence as number;
  const viaDebit = dispute.recovered_via_account_debit_pence as number;
  const recoveredTotal = viaReversal + viaDebit;
  const unrecovered = Math.max(0, owedTotal - recoveredTotal);

  await supabase
    .from("disputes")
    .update({
      recovery_status: "unpaid",
      unrecovered_pence: unrecovered,
      recovery_invoice_id: invoice.id,
      recovery_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      recovery_notes: "invoice.payment_failed",
    })
    .eq("id", disputeId);

  await setBusinessDisputeHold(
    supabase,
    dispute.business_id as string,
    unrecovered,
    true,
  );

  return { handled: true, action: "invoice_payment_failed_hold", disputeId };
}

export { formatPence as formatRecoveryPence };
