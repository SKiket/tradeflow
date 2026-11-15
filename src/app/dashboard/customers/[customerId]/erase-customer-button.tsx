"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type Props = {
  customerId: string;
  customerLabel: string;
};

export function EraseCustomerButton({ customerId, customerLabel }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onErase() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dashboard/customers/${customerId}/erase`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        blockingOrderRefs?: string[];
        ok?: boolean;
      };
      if (!response.ok) {
        const refs = body.blockingOrderRefs?.length
          ? ` (${body.blockingOrderRefs.join(", ")})`
          : "";
        setError((body.error ?? "Erase failed") + refs);
        return;
      }
      setDone(true);
      setConfirming(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="text-sm text-muted-foreground">
        Customer erased. Messages deleted; orders kept anonymised for tax
        records.
      </p>
    );
  }

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="outline"
        className="border-destructive/40 text-destructive hover:bg-destructive/5"
        onClick={() => setConfirming(true)}
      >
        Erase this customer
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-medium">Erase {customerLabel}?</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Deletes WhatsApp messages and queued retries for this customer.</li>
        <li>
          Anonymises their profile (name and phone cleared). The same phone can
          become a new customer later.
        </li>
        <li>
          Keeps order totals, dates and status for UK tax (6 years), with name,
          phone and address removed.
        </li>
        <li>
          Blocked if they have an unpaid, unpaid-unfulfilled, or open
          refund/return order.
        </li>
      </ul>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() => void onErase()}
        >
          {busy ? "Erasing…" : "Confirm erase"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
