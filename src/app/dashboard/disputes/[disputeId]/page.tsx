import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import {
  disputeReasonLabel,
  getDisputeCounterFeePence,
  getDisputeFeePence,
  getDisputeReceivedFeePence,
  isOpenDisputeStatus,
} from "@/lib/disputes/constants";
import { isInServiceWindow } from "@/lib/channels/service-window";
import { getCustomerPreferredLanguage } from "@/lib/i18n/language";
import { formatDateTime, formatPence } from "@/lib/orders/display";
import { createAdminClient } from "@/lib/supabase/admin";

import { requireSeller } from "../../require-seller";
import { DisputeActions } from "./dispute-actions";
import { DisputeResolution } from "./dispute-resolution";

interface PageProps {
  params: Promise<{ disputeId: string }>;
}

function countdown(dueBy: string | null): string {
  if (!dueBy) return "No deadline recorded";
  const ms = new Date(dueBy).getTime() - Date.now();
  if (!Number.isFinite(ms)) return formatDateTime(dueBy);
  if (ms <= 0) return "Deadline passed";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  if (days >= 2) return `${days} days left`;
  if (hours >= 1) return `${hours} hours left`;
  const mins = Math.max(1, Math.floor(ms / 60000));
  return `${mins} minutes left`;
}

const PREFILL = {
  en: (orderRef: string) =>
    `I'm sorry about the problem with order ${orderRef}. I can offer a refund or a replacement once the dispute with your bank is withdrawn. If you are happy with that, please ask your bank to withdraw the dispute, and I will sort this out afterwards.`,
  fr: (orderRef: string) =>
    `Je suis désolé(e) pour le problème concernant la commande ${orderRef}. Je peux proposer un remboursement ou un remplacement une fois le litige retiré auprès de votre banque. Si cela vous convient, demandez à votre banque de retirer le litige, puis je réglerai la suite.`,
} as const;

export default async function DisputeDetailPage({ params }: PageProps) {
  const { disputeId } = await params;
  const { supabase, businessId } = await requireSeller();

  const { data: dispute } = await supabase
    .from("disputes")
    .select(
      "id, order_id, amount_pence, currency, reason, status, evidence_due_by, evidence_status, evidence_submitted_at, submitted_by, outcome, stripe_fee_pence, fee_pence, received_fee_pence, counter_fee_pence, recovered_pence, unrecovered_pence, recovered_via_reversal_pence, recovered_via_account_debit_pence, recovered_via_invoice_pence, recovery_status, seller_notes, funds_withdrawn_at, funds_reinstated_at, accepted_at, created_at, closed_at, orders(id, order_ref, customer_id)",
    )
    .eq("id", disputeId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (!dispute) notFound();

  const orders = dispute.orders as
    | { id: string; order_ref: string; customer_id: string | null }
    | { id: string; order_ref: string; customer_id: string | null }[]
    | null;
  const order = Array.isArray(orders) ? orders[0] : orders;
  const open = isOpenDisputeStatus(dispute.status as string);
  const accepted = Boolean(dispute.accepted_at);
  const evidenceSubmitted =
    dispute.evidence_status === "submitted" ||
    Boolean(dispute.evidence_submitted_at);
  const canEdit =
    open &&
    !accepted &&
    dispute.evidence_status !== "submitted" &&
    !dispute.evidence_submitted_at;

  const feePence =
    (dispute.fee_pence as number | null) ??
    (dispute.stripe_fee_pence as number | null) ??
    getDisputeFeePence();
  const receivedFeePence =
    (dispute.received_fee_pence as number | null) ??
    getDisputeReceivedFeePence();
  const counterFeePence =
    (dispute.counter_fee_pence as number | null) ??
    getDisputeCounterFeePence();

  let prefill = PREFILL.en(order?.order_ref ?? "your order");
  let inWindow = false;
  if (order?.customer_id) {
    const admin = createAdminClient();
    const lang = await getCustomerPreferredLanguage(admin, order.customer_id);
    prefill = PREFILL[lang === "fr" ? "fr" : "en"](
      order.order_ref ?? "your order",
    );
    const { data: customer } = await supabase
      .from("customers")
      .select("last_customer_message_at")
      .eq("id", order.customer_id)
      .maybeSingle();
    inWindow = isInServiceWindow({
      last_customer_message_at:
        (customer?.last_customer_message_at as string | null) ?? null,
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/dashboard/disputes"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Disputes
        </Link>
        <h1 className="tf-page-heading mt-2">
          Dispute · {order?.order_ref ?? "Unmatched"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {formatPence(dispute.amount_pence as number)} ·{" "}
          {disputeReasonLabel(dispute.reason as string | null)}
        </p>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="font-medium">
            {open ? "Open" : "Closed"}
            {dispute.outcome ? ` — ${dispute.outcome}` : ""}
            {accepted ? " (accepted)" : ""}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Evidence deadline</dt>
          <dd className="font-medium">
            {dispute.evidence_due_by
              ? formatDateTime(dispute.evidence_due_by as string)
              : "n/a"}{" "}
            <span className="text-muted-foreground">
              ({countdown((dispute.evidence_due_by as string | null) ?? null)})
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Evidence</dt>
          <dd className="font-medium">
            {dispute.evidence_status as string}
            {dispute.submitted_by
              ? ` (by ${dispute.submitted_by})`
              : ""}
          </dd>
        </div>
        {order ? (
          <div>
            <dt className="text-muted-foreground">Order</dt>
            <dd>
              <Link
                href={`/dashboard/orders/${order.id}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {order.order_ref}
              </Link>
            </dd>
          </div>
        ) : null}
        {dispute.recovery_status ? (
          <div>
            <dt className="text-muted-foreground">Recovery</dt>
            <dd className="font-medium">{dispute.recovery_status as string}</dd>
          </div>
        ) : null}
      </dl>

      {open ? (
        <DisputeResolution
          disputeId={dispute.id as string}
          amountPence={dispute.amount_pence as number}
          receivedFeePence={receivedFeePence}
          counterFeePence={counterFeePence}
          deadlineLabel={
            dispute.evidence_due_by
              ? formatDateTime(dispute.evidence_due_by as string)
              : "n/a"
          }
          canAct={open}
          accepted={accepted}
          evidenceSubmitted={evidenceSubmitted}
          prefillMessage={prefill}
          inServiceWindow={inWindow}
        />
      ) : null}

      <div className="rounded-lg border bg-muted/30 p-4 text-sm">
        <p className="font-medium">Evidence pack preview</p>
        <p className="mt-1 text-muted-foreground">
          TradeFlow stages customer details for this order, line items,
          shipping and tracking, delivery confirmation, your returns policy,
          a short timeline, and the WhatsApp conversation as a file. Nothing is
          final until you confirm (or auto-submit runs).
        </p>
      </div>

      <DisputeActions
        disputeId={dispute.id as string}
        initialNotes={(dispute.seller_notes as string | null) ?? ""}
        canEdit={canEdit}
      />

      {!open && dispute.outcome === "lost" ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-950">
          <p className="font-medium">This dispute was lost</p>
          <p className="mt-1">
            Recovered via transfer:{" "}
            {formatPence(
              (dispute.recovered_via_reversal_pence as number) ?? 0,
            )}
            ; account debit:{" "}
            {formatPence(
              (dispute.recovered_via_account_debit_pence as number) ?? 0,
            )}
            ; card invoice:{" "}
            {formatPence(
              (dispute.recovered_via_invoice_pence as number) ?? 0,
            )}
            . Total recovered:{" "}
            {formatPence((dispute.recovered_pence as number) ?? 0)}.
            {(dispute.unrecovered_pence as number) > 0
              ? ` Still owed: ${formatPence(dispute.unrecovered_pence as number)}.`
              : null}
            {` Dispute fee used for recovery: ${formatPence(feePence)}.`}
          </p>
        </div>
      ) : null}

      {!open && dispute.outcome === "won" ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
          <p className="font-medium">This dispute was won</p>
          <p className="mt-1">
            Funds were reinstated
            {dispute.funds_reinstated_at
              ? ` (${formatDateTime(dispute.funds_reinstated_at as string)})`
              : ""}
            . No recovery was taken from your account. Note: under UK Stripe
            pricing the dispute-received fee is not returned.
          </p>
        </div>
      ) : null}
    </div>
  );
}
