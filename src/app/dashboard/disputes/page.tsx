import Link from "next/link";

import {
  disputeReasonLabel,
  isOpenDisputeStatus,
} from "@/lib/disputes/constants";
import { formatDateTime, formatPence } from "@/lib/orders/display";

import { requireSeller } from "../require-seller";

export default async function DisputesPage() {
  const { supabase, businessId } = await requireSeller();
  const { data, error } = await supabase
    .from("disputes")
    .select(
      "id, amount_pence, currency, reason, status, evidence_due_by, evidence_status, outcome, created_at, closed_at, unrecovered_pence, orders(id, order_ref)",
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Disputes</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load disputes. {error.message}
        </p>
      </div>
    );
  }

  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="tf-page-heading">Disputes</h1>
        <p className="text-sm text-muted-foreground">
          Payment disputes from customers. TradeFlow prepares evidence; you
          confirm before the deadline. Lost disputes (amount + fee) come out of
          your payouts.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No disputes yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((row) => {
            const orders = row.orders as
              | { id: string; order_ref: string }
              | { id: string; order_ref: string }[]
              | null;
            const order = Array.isArray(orders) ? orders[0] : orders;
            const open = isOpenDisputeStatus(row.status as string);
            return (
              <li key={row.id as string}>
                <Link
                  href={`/dashboard/disputes/${row.id}`}
                  className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {order?.order_ref ?? "Unmatched order"} ·{" "}
                      {formatPence(row.amount_pence as number)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {disputeReasonLabel(row.reason as string | null)} ·{" "}
                      {open
                        ? `Open — due ${row.evidence_due_by ? formatDateTime(row.evidence_due_by as string) : "n/a"}`
                        : `Closed — ${row.outcome ?? row.status}`}
                    </p>
                  </div>
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {row.evidence_status as string}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
