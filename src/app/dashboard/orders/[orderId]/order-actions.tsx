"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPence, poundsToPence, penceToPoundsInput } from "@/lib/orders/display";
import { RETURN_REASON_LABEL, parseReturnReason } from "@/lib/orders/return-reasons";
import { ORDER_STATUS, REFUNDABLE_STATUSES } from "@/lib/orders/status";

type QuotedRate = {
  objectId: string;
  carrier: string;
  service: string;
  amount: string;
  currency: string;
  estimatedDays: number | null;
};

export type OrderActionsProps = {
  orderId: string;
  orderRef: string;
  status: string;
  totalPence: number;
  refundedAmountPence: number;
  hasPaymentIntent: boolean;
  returnReason: string | null;
  returnReasonDetail: string | null;
  returnNotes: string | null;
  returnAutoApproved: boolean;
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

function formatRatePrice(amount: string, currency: string) {
  const value = Number.parseFloat(amount);
  if (!Number.isFinite(value)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
    }).format(value);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatEta(days: number | null) {
  if (days === null) return "Transit time not quoted";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function OrderActions({
  orderId,
  orderRef,
  status,
  totalPence,
  refundedAmountPence,
  hasPaymentIntent,
  returnReason,
  returnReasonDetail,
  returnNotes,
  returnAutoApproved,
}: OrderActionsProps) {
  const router = useRouter();
  const remainingPence = Math.max(0, totalPence - (refundedAmountPence ?? 0));
  const remainingPounds = penceToPoundsInput(remainingPence);

  const canDispatch = status === ORDER_STATUS.PAID;
  const canDeliver = status === ORDER_STATUS.DISPATCHED;
  const canDecideReturn = status === ORDER_STATUS.RETURN_REQUESTED;
  const canMarkReturned = status === ORDER_STATUS.RETURN_APPROVED;
  const canRefund =
    hasPaymentIntent &&
    remainingPence > 0 &&
    (REFUNDABLE_STATUSES as readonly string[]).includes(status);

  const parsedReason = parseReturnReason(returnReason);
  const reasonLabel = parsedReason
    ? RETURN_REASON_LABEL[parsedReason]
    : returnReason;

  const [rates, setRates] = useState<QuotedRate[]>([]);
  const [shipmentId, setShipmentId] = useState<string | null>(null);
  const [weightGrams, setWeightGrams] = useState<number | null>(null);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState(remainingPounds);
  const [refundReason, setRefundReason] = useState("");
  const [decisionNotes, setDecisionNotes] = useState("");
  const [pending, setPending] = useState<
    "dispatch" | "deliver" | "refund" | "approve" | "decline" | "returned" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setRefundAmount(penceToPoundsInput(remainingPence));
  }, [remainingPence]);

  const loadRates = useCallback(async () => {
    setRatesLoading(true);
    setRatesError(null);
    try {
      const { json } = await postAction(`/api/orders/${orderId}/shipping-rates`);
      const list = Array.isArray(json.rates) ? (json.rates as QuotedRate[]) : [];
      setRates(list);
      setShipmentId(typeof json.shipmentId === "string" ? json.shipmentId : null);
      setWeightGrams(typeof json.weightGrams === "number" ? json.weightGrams : null);
      setSelectedRateId(list[0]?.objectId ?? null);
    } catch (caught) {
      setRates([]);
      setShipmentId(null);
      setSelectedRateId(null);
      setRatesError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRatesLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    if (canDispatch) {
      void loadRates();
    }
  }, [canDispatch, loadRates]);

  const typedRefundPence = poundsToPence(refundAmount);
  const refundOverCap =
    typedRefundPence !== null && typedRefundPence > remainingPence;
  const selectedRate = rates.find((rate) => rate.objectId === selectedRateId);

  const showAutoApprovedLabel =
    returnAutoApproved &&
    (status === ORDER_STATUS.RETURN_APPROVED ||
      status === ORDER_STATUS.RETURNED);

  if (
    !canDispatch &&
    !canDeliver &&
    !canRefund &&
    !canDecideReturn &&
    !canMarkReturned &&
    !showAutoApprovedLabel &&
    !error &&
    !success
  ) {
    return null;
  }

  async function run(
    kind: "dispatch" | "deliver" | "refund" | "approve" | "decline" | "returned",
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
                if (!selectedRate) {
                  throw new Error("Select a shipping rate before dispatching.");
                }
                await postAction(`/api/orders/${orderId}/dispatch`, {
                  rateObjectId: selectedRate.objectId,
                  shipmentId: shipmentId ?? undefined,
                  carrier: selectedRate.carrier,
                });
                setSuccess("Label purchased and order marked as dispatched.");
              });
            }}
          >
            <p className="text-sm font-medium">Buy a shipping label</p>
            <p className="text-xs text-muted-foreground">
              Rates come from Shippo. Parcel is a single 20×15×10 cm box;
              weight is the sum of item weights.
              {weightGrams !== null ? ` Current parcel: ${weightGrams} g.` : ""}
            </p>
            {ratesLoading ? (
              <p className="text-sm text-muted-foreground">Fetching rates…</p>
            ) : ratesError ? (
              <div className="space-y-2">
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {ratesError}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending !== null || ratesLoading}
                  onClick={() => {
                    void loadRates();
                  }}
                >
                  {ratesLoading ? "Retrying…" : "Retry rates"}
                </Button>
              </div>
            ) : (
              <fieldset className="space-y-2" disabled={pending !== null}>
                <legend className="sr-only">Shipping rates</legend>
                {rates.map((rate) => (
                  <label
                    key={rate.objectId}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
                      selectedRateId === rate.objectId
                        ? "border-foreground bg-muted/40"
                        : "border-border"
                    }`}
                  >
                    <input
                      type="radio"
                      name="shippo-rate"
                      className="mt-1"
                      value={rate.objectId}
                      checked={selectedRateId === rate.objectId}
                      onChange={() => setSelectedRateId(rate.objectId)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-medium">
                        {rate.carrier} · {rate.service}
                      </span>
                      <span className="text-muted-foreground">
                        {formatRatePrice(rate.amount, rate.currency)} ·{" "}
                        {formatEta(rate.estimatedDays)}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <Button
              type="submit"
              disabled={
                pending !== null ||
                ratesLoading ||
                Boolean(ratesError) ||
                !selectedRate
              }
            >
              {pending === "dispatch"
                ? "Purchasing label…"
                : "Purchase label and dispatch"}
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

        {showAutoApprovedLabel && (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-950">
            Auto-approved — statutory cooling-off right
          </p>
        )}

        {canDecideReturn && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Return request</p>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Reason</dt>
                <dd className="font-medium">{reasonLabel ?? "—"}</dd>
              </div>
              {returnReasonDetail?.trim() ? (
                <div>
                  <dt className="text-muted-foreground">Details</dt>
                  <dd className="mt-1 whitespace-pre-wrap">{returnReasonDetail}</dd>
                </div>
              ) : null}
              {returnNotes?.trim() ? (
                <div>
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd className="mt-1 whitespace-pre-wrap">{returnNotes}</dd>
                </div>
              ) : null}
            </dl>
            <div className="space-y-1">
              <Label htmlFor="return-notes">Notes (optional)</Label>
              <Input
                id="return-notes"
                value={decisionNotes}
                onChange={(event) => setDecisionNotes(event.target.value)}
                placeholder="Shown internally"
                disabled={pending !== null}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={pending !== null}
                onClick={() => {
                  void run("approve", async () => {
                    await postAction(`/api/orders/${orderId}/return-decision`, {
                      decision: "approve",
                      notes: decisionNotes.trim() || undefined,
                    });
                    setSuccess("Return approved. Buyer has been sent the return slip.");
                  });
                }}
              >
                {pending === "approve" ? "Approving…" : "Approve return"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending !== null}
                onClick={() => {
                  void run("decline", async () => {
                    await postAction(`/api/orders/${orderId}/return-decision`, {
                      decision: "decline",
                      notes: decisionNotes.trim() || undefined,
                    });
                    setSuccess("Return declined. Buyer has been notified.");
                  });
                }}
              >
                {pending === "decline" ? "Declining…" : "Decline return"}
              </Button>
            </div>
          </div>
        )}

        {canMarkReturned && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("returned", async () => {
                await postAction(`/api/orders/${orderId}/mark-returned`);
                setSuccess("Order marked as returned.");
              });
            }}
          >
            <p className="text-sm font-medium">Returned parcel</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Buyer tracking slip: /t/{orderRef}/return-slip
            </p>
            <Button type="submit" className="mt-3" disabled={pending !== null}>
              {pending === "returned" ? "Updating…" : "Mark as Returned"}
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
