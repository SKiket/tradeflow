import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import {
  disputeReasonLabel,
  isOpenDisputeStatus,
} from "@/lib/disputes/constants";
import { formatDateTime, formatPence } from "@/lib/orders/display";

import { requireSeller } from "../../require-seller";
import { DisputeActions } from "./dispute-actions";

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

export default async function DisputeDetailPage({ params }: PageProps) {
  const { disputeId } = await params;
  const { supabase, businessId } = await requireSeller();

  const { data: dispute } = await supabase
    .from("disputes")
    .select(
      "id, order_id, amount_pence, currency, reason, status, evidence_due_by, evidence_status, evidence_submitted_at, submitted_by, outcome, stripe_fee_pence, recovered_pence, unrecovered_pence, seller_notes, funds_withdrawn_at, funds_reinstated_at, created_at, closed_at, orders(id, order_ref)",
    )
    .eq("id", disputeId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (!dispute) notFound();

  const orders = dispute.orders as
    | { id: string; order_ref: string }
    | { id: string; order_ref: string }[]
    | null;
  const order = Array.isArray(orders) ? orders[0] : orders;
  const open = isOpenDisputeStatus(dispute.status as string);
  const canEdit =
    open &&
    dispute.evidence_status !== "submitted" &&
    !dispute.evidence_submitted_at;

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
      </dl>

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
            Recovered from your connected account:{" "}
            {formatPence((dispute.recovered_pence as number) ?? 0)}.
            {(dispute.unrecovered_pence as number) > 0
              ? ` Unrecovered (beyond what Stripe could reverse from the original transfer): ${formatPence(dispute.unrecovered_pence as number)}.`
              : null}
            {dispute.stripe_fee_pence
              ? ` Stripe dispute fee recorded: ${formatPence(dispute.stripe_fee_pence as number)}.`
              : null}
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
            . No recovery was taken from your payouts.
          </p>
        </div>
      ) : null}
    </div>
  );
}
