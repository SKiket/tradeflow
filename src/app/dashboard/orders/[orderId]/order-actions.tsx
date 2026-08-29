"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPence } from "@/lib/orders/display";
import { ORDER_STATUS, REFUNDABLE_STATUSES } from "@/lib/orders/status";

export type OrderActionsProps = {
  orderId: string;
  status: string;
  totalPence: number;
  refundedAmountPence: number;
  hasPaymentIntent: boolean;
};

function apiErrorMessage(json: unknown, status: number): string {
  if (json && typeof json === "object" && "error" in json) {
    const error = (json as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return `Request failed (${status})`;
}

async function postAction(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true; json: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || json.ok === false) {
    throw new Error(apiErrorMessage(json, response.status));
  }
  return { ok: true, json };
}

function poundsToPence(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function penceToPoundsInput(pence: number): string {
  return (pence / 100).toFixed(2);
}

export function OrderActions({
  orderId,
  status,
  totalPence,
  refundedAmountPence,
  hasPaymentIntent,
}: OrderActionsProps) {
  const router = useRouter();
  const remainingPence = Math.max(0, totalPence - (refundedAmountPence ?? 0));
  const remainingPounds = penceToPoundsInput(remainingPence);

  const canDispatch = status === ORDER_STATUS.PAID;
  const canDeliver = status === ORDER_STATUS.DISPATCHED;
  const canRefund =
    hasPaymentIntent &&
    remainingPence > 0 &&
    (REFUNDABLE_STATUSES as readonly string[]).includes(status);

  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [refundAmount, setRefundAmount] = useState(remainingPounds);
  const [refundReason, setRefundReason] = useState("");
  const [pending, setPending] = useState<
    "dispatch" | "deliver" | "refund" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setRefundAmount(penceToPoundsInput(remainingPence));
  }, [remainingPence]);

  const typedRefundPence = poundsToPence(refundAmount);
  const refundOverCap =
    typedRefundPence !== null && typedRefundPence > remainingPence;

  if (!canDispatch && !canDeliver && !canRefund && !error && !success) {
    return null;
  }

  async function run(
    kind: "dispatch" | "deliver" | "refund",
    work: () => Promise<void>,
  ) {
    setPending(kind);
    setError(null);
    setSuccess(null);
    try {
      await work();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Actions
      </h2>
      <div className="space-y-4 rounded-xl border p-4">
        {canDispatch && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run("dispatch", async () => {
                await postAction(`/api/orders/${orderId}/dispatch`, {
                  trackingNumber: trackingNumber.trim() || undefined,
                  carrier: carrier.trim() || undefined,
                });
                setSuccess("Order marked as dispatched.");
              });
            }}
          >
            <p className="text-sm font-medium">Mark as dispatched</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="tracking-number">Tracking number</Label>
                <Input
                  id="tracking-number"
                  value={trackingNumber}
                  onChange={(event) => setTrackingNumber(event.target.value)}
                  placeholder="Optional"
                  disabled={pending !== null}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="carrier">Carrier</Label>
                <Input
                  id="carrier"
                  value={carrier}
                  onChange={(event) => setCarrier(event.target.value)}
                  placeholder="Optional"
                  disabled={pending !== null}
                />
              </div>
            </div>
            <Button type="submit" disabled={pending !== null}>
              {pending === "dispatch" ? "Dispatching…" : "Mark as Dispatched"}
            </Button>
          </form>
        )}

        {canDeliver && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("deliver", async () => {
                await postAction(`/api/orders/${orderId}/deliver`);
                setSuccess("Order marked as delivered.");
              });
            }}
          >
            <Button type="submit" disabled={pending !== null}>
              {pending === "deliver" ? "Updating…" : "Mark as Delivered"}
            </Button>
          </form>
        )}

        {canRefund && (
          <form
            className="space-y-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void run("refund", async () => {
                const amountPence = poundsToPence(refundAmount);
                if (amountPence === null || amountPence <= 0) {
                  throw new Error("Enter an amount greater than 0");
                }
                await postAction(`/api/orders/${orderId}/refund`, {
                  amountPence,
                  reason: refundReason.trim() || undefined,
                });
                setSuccess(
                  "Refund submitted. Status will update when Stripe confirms.",
                );
              });
            }}
          >
            <p className="text-sm font-medium">Issue refund</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="refund-amount">Amount (£)</Label>
                <Input
                  id="refund-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  max={remainingPounds}
                  step="0.01"
                  value={refundAmount}
                  onChange={(event) => setRefundAmount(event.target.value)}
                  disabled={pending !== null}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Refundable: {formatPence(remainingPence)}
                </p>
                {refundOverCap && (
                  <p className="text-xs text-destructive">
                    Amount is over the refundable total.
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="refund-reason">Reason</Label>
                <Input
                  id="refund-reason"
                  value={refundReason}
                  onChange={(event) => setRefundReason(event.target.value)}
                  placeholder="Optional"
                  disabled={pending !== null}
                />
              </div>
            </div>
            <Button
              type="submit"
              variant="destructive"
              disabled={pending !== null}
            >
              {pending === "refund" ? "Submitting…" : "Issue Refund"}
            </Button>
          </form>
        )}

        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {success && !error && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {success}
          </p>
        )}
      </div>
    </section>
  );
}
