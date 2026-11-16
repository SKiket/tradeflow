"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatPence } from "@/lib/orders/display";

export function DisputeResolution({
  disputeId,
  amountPence,
  receivedFeePence,
  counterFeePence,
  deadlineLabel,
  canAct,
  accepted,
  evidenceSubmitted,
  prefillMessage,
  inServiceWindow,
}: {
  disputeId: string;
  amountPence: number;
  receivedFeePence: number;
  counterFeePence: number;
  deadlineLabel: string;
  canAct: boolean;
  accepted: boolean;
  evidenceSubmitted: boolean;
  prefillMessage: string;
  inServiceWindow: boolean;
}) {
  const router = useRouter();
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [pending, setPending] = useState<"accept" | "send" | "copy" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [message, setMessage] = useState(prefillMessage);
  const [copiedNote, setCopiedNote] = useState<string | null>(null);

  const locked = accepted || evidenceSubmitted || !canAct;

  const comparison = useMemo(() => {
    const acceptTotal = amountPence + receivedFeePence;
    const contestLoseTotal = amountPence + receivedFeePence + counterFeePence;
    return {
      amount: formatPence(amountPence),
      received: formatPence(receivedFeePence),
      counter: formatPence(counterFeePence),
      acceptTotal: formatPence(acceptTotal),
      contestLoseTotal: formatPence(contestLoseTotal),
      acceptMayCostLess: amountPence < receivedFeePence + counterFeePence,
    };
  }, [amountPence, receivedFeePence, counterFeePence]);

  async function accept() {
    setError(null);
    setSuccess(null);
    setPending("accept");
    try {
      const response = await fetch(
        `/api/dashboard/disputes/${disputeId}/accept`,
        { method: "POST" },
      );
      const json = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(json.error ?? `Request failed (${response.status})`);
      }
      setSuccess("Dispute accepted. The contest form is now locked.");
      setConfirmAccept(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  async function messageBuyer(mode: "send" | "copied") {
    setError(null);
    setSuccess(null);
    setCopiedNote(null);
    setPending(mode === "send" ? "send" : "copy");
    try {
      const response = await fetch(
        `/api/dashboard/disputes/${disputeId}/message-buyer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message, mode }),
        },
      );
      const json = (await response.json().catch(() => ({}))) as {
        error?: string;
        note?: string | null;
        text?: string;
        mode?: string;
      };
      if (!response.ok) {
        throw new Error(json.error ?? `Request failed (${response.status})`);
      }
      if (mode === "copied" || json.mode === "copied") {
        await navigator.clipboard.writeText(json.text ?? message);
        setCopiedNote(
          json.note ??
            "Copied. We recorded that you copied this — not that it was delivered.",
        );
      } else {
        setSuccess(
          "Message sent to the buyer. We recorded that it was sent — delivery is not guaranteed.",
        );
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <p className="font-medium">Accept or contest</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Deadline: {deadlineLabel}. Disputed amount {comparison.amount}.
        </p>
      </div>

      <ul className="space-y-2 text-sm">
        <li>
          <span className="font-medium">Accept the dispute:</span> you lose{" "}
          {comparison.amount} and pay the {comparison.received} received fee
          (total {comparison.acceptTotal}). Accepting is final.
        </li>
        <li>
          <span className="font-medium">Contest with evidence and lose:</span>{" "}
          you lose {comparison.amount} plus the {comparison.received} received
          fee and a {comparison.counter} counter fee (total{" "}
          {comparison.contestLoseTotal}).
        </li>
        <li>
          <span className="font-medium">Contest with evidence and win:</span>{" "}
          you keep the sale and owe £0. TradeFlow absorbs the received fee; any
          counter fee Stripe charged is returned on a win.
        </li>
        <li>
          <span className="font-medium">Ask the buyer to withdraw:</span> message
          them below. Do not refund while the dispute is open — Stripe blocks
          that and it risks paying twice. If the buyer withdraws with their
          bank, you can refund them afterwards if you wish.
        </li>
      </ul>

      {comparison.acceptMayCostLess ? (
        <p className="text-sm text-amber-900">
          This order is under {formatPence(receivedFeePence + counterFeePence)}.
          Accepting may cost less than contesting and losing.
        </p>
      ) : null}

      {locked ? (
        <p className="text-sm text-muted-foreground">
          {accepted
            ? "You accepted this dispute. Contesting is no longer available."
            : evidenceSubmitted
              ? "Evidence already submitted. Accept is no longer available."
              : "This dispute is closed."}
        </p>
      ) : (
        <div className="space-y-3 border-t pt-3">
          {!confirmAccept ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending !== null}
              onClick={() => setConfirmAccept(true)}
            >
              Accept the dispute…
            </Button>
          ) : (
            <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
              <p>
                Confirm: you will lose {comparison.amount} and pay{" "}
                {comparison.received}. This cannot be undone.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void accept()}
                >
                  {pending === "accept" ? "Accepting…" : "Yes, accept"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => setConfirmAccept(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="cheaper-msg">Message the buyer</Label>
            <textarea
              id="cheaper-msg"
              className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={4000}
            />
            {inServiceWindow ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending !== null || !message.trim()}
                onClick={() => void messageBuyer("send")}
              >
                {pending === "send" ? "Sending…" : "Send message"}
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  The buyer is outside WhatsApp&apos;s 24-hour window. Copy this
                  and contact them another way.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending !== null || !message.trim()}
                  onClick={() => void messageBuyer("copied")}
                >
                  {pending === "copy" ? "Copying…" : "Copy message"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {success ? <p className="text-sm text-emerald-700">{success}</p> : null}
      {copiedNote ? (
        <p className="text-sm text-muted-foreground">{copiedNote}</p>
      ) : null}
    </div>
  );
}
