import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import {
  isOpenDisputeStatus,
  outcomeFromStripeStatus,
} from "@/lib/disputes/constants";
import { buildDisputeEvidence } from "@/lib/disputes/evidence";
import {
  notifySellerDisputeClosed,
  notifySellerDisputeOpened,
} from "@/lib/disputes/notify";
import { getDisputeFeePence } from "@/lib/disputes/constants";
import {
  extractDisputeFeePence,
  markRecoveryNotNeeded,
  runFullDisputeRecovery,
} from "@/lib/disputes/recover";
import { resolveOrderForDispute } from "@/lib/disputes/resolve-order";

export type DisputeEventResult = {
  handled: boolean;
  action: string;
  disputeId?: string;
  orderId?: string | null;
  reason?: string;
};

type DisputeRow = {
  id: string;
  business_id: string;
  order_id: string | null;
  status: string;
  outcome: string | null;
  closed_at: string | null;
  evidence_status: string;
  evidence_submitted_at: string | null;
  opened_notified_at: string | null;
  closed_notified_at: string | null;
  funds_withdrawn_at: string | null;
  funds_reinstated_at: string | null;
  stripe_transfer_reversal_id: string | null;
  stripe_fee_pence: number | null;
  recovery_status: string | null;
};

async function loadDisputeByStripeId(
  supabase: SupabaseClient,
  stripeDisputeId: string,
): Promise<DisputeRow | null> {
  const { data, error } = await supabase
    .from("disputes")
    .select(
      "id, business_id, order_id, status, outcome, closed_at, evidence_status, evidence_submitted_at, opened_notified_at, closed_notified_at, funds_withdrawn_at, funds_reinstated_at, stripe_transfer_reversal_id, stripe_fee_pence, recovery_status",
    )
    .eq("stripe_dispute_id", stripeDisputeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DisputeRow | null) ?? null;
}

function dueByIso(dispute: Stripe.Dispute): string | null {
  const due = dispute.evidence_details?.due_by;
  if (!due || due <= 0) return null;
  return new Date(due * 1000).toISOString();
}

/**
 * Process charge.dispute.* events. Idempotent and order-independent:
 * never duplicates notifications or moves a closed dispute backwards.
 */
export async function handleDisputeEvent(
  supabase: SupabaseClient,
  eventType: string,
  dispute: Stripe.Dispute,
): Promise<DisputeEventResult> {
  switch (eventType) {
    case "charge.dispute.created":
      return handleCreated(supabase, dispute);
    case "charge.dispute.updated":
      return handleUpdated(supabase, dispute);
    case "charge.dispute.funds_withdrawn":
      return handleFundsWithdrawn(supabase, dispute);
    case "charge.dispute.funds_reinstated":
      return handleFundsReinstated(supabase, dispute);
    case "charge.dispute.closed":
      return handleClosed(supabase, dispute);
    default:
      return { handled: false, action: "unknown_type", reason: eventType };
  }
}

async function handleCreated(
  supabase: SupabaseClient,
  dispute: Stripe.Dispute,
): Promise<DisputeEventResult> {
  const existing = await loadDisputeByStripeId(supabase, dispute.id);
  if (existing) {
    return {
      handled: true,
      action: "already_exists",
      disputeId: existing.id,
      orderId: existing.order_id,
    };
  }

  const match = await resolveOrderForDispute(supabase, dispute);
  const fee = extractDisputeFeePence(dispute);

  if (!match.orderId) {
    Sentry.captureMessage("dispute_unmatched_order", {
      level: "warning",
      tags: {
        stripe_dispute_id: dispute.id,
      },
      extra: {
        charge_id: match.chargeId || null,
        has_payment_intent: Boolean(match.paymentIntentId),
      },
    });
  }

  // Prefer order's business; else resolve via charge transfer destination.
  let businessId: string | null = match.businessId;
  if (!businessId && match.chargeId) {
    try {
      const { getStripe } = await import("@/lib/stripe/client");
      const charge = await getStripe().charges.retrieve(match.chargeId);
      const dest =
        typeof charge.transfer_data?.destination === "string"
          ? charge.transfer_data.destination
          : null;
      if (dest) {
        const { data: biz } = await supabase
          .from("businesses")
          .select("id")
          .eq("stripe_connected_account_id", dest)
          .maybeSingle();
        businessId = typeof biz?.id === "string" ? biz.id : null;
      }
    } catch {
      // leave null
    }
  }

  if (!businessId) {
    Sentry.captureMessage("dispute_unmatched_no_business", {
      level: "error",
      tags: { stripe_dispute_id: dispute.id },
    });
    console.error("[disputes] unmatched dispute with no business", {
      stripeDisputeId: dispute.id,
      chargeId: match.chargeId,
    });
    return { handled: true, action: "unmatched_no_business", orderId: null };
  }

  const now = new Date().toISOString();
  const { data: inserted, error } = await supabase
    .from("disputes")
    .insert({
      business_id: businessId,
      order_id: match.orderId,
      stripe_dispute_id: dispute.id,
      stripe_charge_id: match.chargeId || (typeof dispute.charge === "string" ? dispute.charge : ""),
      amount_pence: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
      evidence_due_by: dueByIso(dispute),
      evidence_status: "draft",
      stripe_fee_pence: fee,
      stripe_transfer_id: match.transferId,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error) {
    // Unique race: another delivery inserted first.
    if (/duplicate|unique/i.test(error.message)) {
      const again = await loadDisputeByStripeId(supabase, dispute.id);
      return {
        handled: true,
        action: "already_exists",
        disputeId: again?.id,
        orderId: again?.order_id ?? match.orderId,
      };
    }
    throw new Error(error.message);
  }

  const disputeId = inserted.id as string;

  if (match.orderId) {
    await supabase
      .from("orders")
      .update({ dispute_status: dispute.status })
      .eq("id", match.orderId)
      .eq("business_id", businessId);
  }

  // Build draft evidence immediately when we have an order.
  if (match.orderId) {
    try {
      await buildDisputeEvidence(supabase, disputeId, { submit: false });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      console.error("[disputes] draft evidence build failed", {
        disputeId,
        error: message,
      });
    }
  }

  // Notify seller once.
  if (match.orderId) {
    const { data: order } = await supabase
      .from("orders")
      .select("order_ref")
      .eq("id", match.orderId)
      .maybeSingle();
    const orderRef = (order?.order_ref as string | undefined) ?? "unknown";
    await notifySellerDisputeOpened({
      supabase,
      businessId,
      orderRef,
      evidenceDueBy: dueByIso(dispute),
    });
    await supabase
      .from("disputes")
      .update({ opened_notified_at: now, updated_at: now })
      .eq("id", disputeId)
      .is("opened_notified_at", null);
  } else {
    Sentry.captureMessage("dispute_recorded_without_order", {
      level: "warning",
      tags: {
        stripe_dispute_id: dispute.id,
        business_id: businessId,
      },
    });
  }

  return {
    handled: true,
    action: "created",
    disputeId,
    orderId: match.orderId,
  };
}

async function handleUpdated(
  supabase: SupabaseClient,
  dispute: Stripe.Dispute,
): Promise<DisputeEventResult> {
  let row = await loadDisputeByStripeId(supabase, dispute.id);
  if (!row) {
    // Out-of-order: created missing — upsert via created path.
    const created = await handleCreated(supabase, dispute);
    row = await loadDisputeByStripeId(supabase, dispute.id);
    if (!row) return created;
  }

  // Never move a closed dispute backwards.
  if (row.closed_at || row.outcome) {
    const fee = extractDisputeFeePence(dispute);
    if (fee != null && row.stripe_fee_pence == null) {
      await supabase
        .from("disputes")
        .update({ stripe_fee_pence: fee, updated_at: new Date().toISOString() })
        .eq("id", row.id);
    }
    return {
      handled: true,
      action: "ignored_closed",
      disputeId: row.id,
      orderId: row.order_id,
    };
  }

  const fee = extractDisputeFeePence(dispute);
  const patch: Record<string, unknown> = {
    status: dispute.status,
    reason: dispute.reason,
    evidence_due_by: dueByIso(dispute),
    updated_at: new Date().toISOString(),
  };
  if (fee != null) patch.stripe_fee_pence = fee;

  // If Stripe reports evidence already submitted, mirror that.
  if (dispute.evidence_details?.submission_count && dispute.evidence_details.submission_count > 0) {
    if (row.evidence_status !== "submitted") {
      patch.evidence_status = "submitted";
      patch.evidence_submitted_at = new Date().toISOString();
      patch.submitted_by = row.evidence_submitted_at ? undefined : "seller";
    }
  }

  await supabase.from("disputes").update(patch).eq("id", row.id);

  if (row.order_id) {
    await supabase
      .from("orders")
      .update({ dispute_status: dispute.status })
      .eq("id", row.order_id)
      .eq("business_id", row.business_id);
  }

  return {
    handled: true,
    action: "updated",
    disputeId: row.id,
    orderId: row.order_id,
  };
}

async function handleFundsWithdrawn(
  supabase: SupabaseClient,
  dispute: Stripe.Dispute,
): Promise<DisputeEventResult> {
  let row = await loadDisputeByStripeId(supabase, dispute.id);
  if (!row) {
    await handleCreated(supabase, dispute);
    row = await loadDisputeByStripeId(supabase, dispute.id);
  }
  if (!row) {
    return { handled: true, action: "funds_withdrawn_no_row" };
  }
  if (row.funds_withdrawn_at) {
    return {
      handled: true,
      action: "funds_withdrawn_already",
      disputeId: row.id,
    };
  }

  const fee = extractDisputeFeePence(dispute);
  await supabase
    .from("disputes")
    .update({
      funds_withdrawn_at: new Date().toISOString(),
      ...(fee != null ? { stripe_fee_pence: fee } : {}),
      status: dispute.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .is("funds_withdrawn_at", null);

  return {
    handled: true,
    action: "funds_withdrawn",
    disputeId: row.id,
    orderId: row.order_id,
  };
}

async function handleFundsReinstated(
  supabase: SupabaseClient,
  dispute: Stripe.Dispute,
): Promise<DisputeEventResult> {
  let row = await loadDisputeByStripeId(supabase, dispute.id);
  if (!row) {
    await handleCreated(supabase, dispute);
    row = await loadDisputeByStripeId(supabase, dispute.id);
  }
  if (!row) {
    return { handled: true, action: "funds_reinstated_no_row" };
  }
  if (row.funds_reinstated_at) {
    return {
      handled: true,
      action: "funds_reinstated_already",
      disputeId: row.id,
    };
  }

  await supabase
    .from("disputes")
    .update({
      funds_reinstated_at: new Date().toISOString(),
      status: dispute.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .is("funds_reinstated_at", null);

  return {
    handled: true,
    action: "funds_reinstated",
    disputeId: row.id,
    orderId: row.order_id,
  };
}

async function handleClosed(
  supabase: SupabaseClient,
  dispute: Stripe.Dispute,
): Promise<DisputeEventResult> {
  let row = await loadDisputeByStripeId(supabase, dispute.id);
  if (!row) {
    await handleCreated(supabase, dispute);
    row = await loadDisputeByStripeId(supabase, dispute.id);
  }
  if (!row) {
    return { handled: true, action: "closed_no_row" };
  }

  const outcome =
    outcomeFromStripeStatus(dispute.status) ??
    outcomeFromStripeStatus(row.status) ??
    null;

  // Idempotent close: if already closed with outcome, only fill missing bits.
  const alreadyClosed = Boolean(row.closed_at && row.outcome);

  if (!alreadyClosed) {
    const now = new Date().toISOString();
    const fee = extractDisputeFeePence(dispute);
    await supabase
      .from("disputes")
      .update({
        status: dispute.status,
        outcome,
        closed_at: now,
        ...(fee != null ? { stripe_fee_pence: fee } : {}),
        updated_at: now,
      })
      .eq("id", row.id)
      .is("closed_at", null);

    if (row.order_id) {
      await supabase
        .from("orders")
        .update({
          dispute_status: outcome ?? dispute.status,
        })
        .eq("id", row.order_id)
        .eq("business_id", row.business_id);
    }
  }

  // Notify once.
  if (!row.closed_notified_at && outcome && row.order_id) {
    const { data: order } = await supabase
      .from("orders")
      .select("order_ref")
      .eq("id", row.order_id)
      .maybeSingle();
    const orderRef = (order?.order_ref as string | undefined) ?? "unknown";
    await notifySellerDisputeClosed({
      supabase,
      businessId: row.business_id,
      orderRef,
      outcome,
    });
    await supabase
      .from("disputes")
      .update({
        closed_notified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .is("closed_notified_at", null);
  }

  // Recovery: lost → full sequence; won/withdrawn → not_needed.
  const terminalRecovery =
    row.recovery_status === "recovered" ||
    row.recovery_status === "not_needed" ||
    row.recovery_status === "unpaid" ||
    row.recovery_status === "partial";

  if (outcome === "lost") {
    if (!terminalRecovery || row.recovery_status === "pending" || !row.recovery_status) {
      await runFullDisputeRecovery(supabase, row.id);
    }
  } else if (outcome === "won") {
    if (!row.recovery_status || row.recovery_status === "pending") {
      await markRecoveryNotNeeded(supabase, row.id, "won_or_withdrawn");
    }
  }

  // Ensure fee_pence is set for audit even when Stripe BT fee differs.
  if (!alreadyClosed) {
    const feeConstant = getDisputeFeePence();
    await supabase
      .from("disputes")
      .update({
        fee_pence: feeConstant,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .is("fee_pence", null);
  }

  return {
    handled: true,
    action: alreadyClosed ? "closed_already" : "closed",
    disputeId: row.id,
    orderId: row.order_id,
    reason: outcome ?? undefined,
  };
}

/** Helper for banners — re-export open check. */
export { isOpenDisputeStatus };
