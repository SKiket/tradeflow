"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SHOP_CLOSE_GRACE_DAYS } from "@/lib/privacy/constants";

type Props = {
  shopName: string;
  closedAt: string | null;
  purgeAfter: string | null;
};

export function YourDataSection({ shopName, closedAt, purgeAfter }: Props) {
  const router = useRouter();
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function onClose() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/dashboard/shop-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close", confirmName }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        purgeAfter?: string;
        note?: string;
        blockingOrderRefs?: string[];
      };
      if (!response.ok) {
        const refs = body.blockingOrderRefs?.length
          ? ` (${body.blockingOrderRefs.join(", ")})`
          : "";
        setError((body.error ?? "Could not close shop") + refs);
        return;
      }
      setMessage(
        `Shop closed. You can reopen within ${SHOP_CLOSE_GRACE_DAYS} days` +
          (body.purgeAfter
            ? ` (until ${new Date(body.purgeAfter).toLocaleDateString("en-GB")})`
            : "") +
          `. ${body.note ?? ""}`,
      );
      setConfirmName("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onReopen() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/dashboard/shop-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reopen" }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(body.error ?? "Could not reopen shop");
        return;
      }
      setMessage("Shop reopened. Restart billing if needed to take new orders.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border p-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your data
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Download a copy of this shop&apos;s data, or close the shop. Closing
          stops new orders. Your Stripe Connect payout account is not touched —
          it belongs to you.
        </p>
      </div>

      <div>
        <a
          href="/api/dashboard/data-export"
          className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
        >
          Download my data
        </a>
      </div>

      {closedAt ? (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-sm font-medium">This shop is closed</p>
          <p className="text-sm text-muted-foreground">
            Closed on {new Date(closedAt).toLocaleDateString("en-GB")}
            {purgeAfter
              ? `. Permanent deletion after ${new Date(purgeAfter).toLocaleDateString("en-GB")}.`
              : "."}{" "}
            Log in and reopen before then to keep the shop.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void onReopen()}
          >
            {busy ? "Working…" : "Reopen this shop"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Label htmlFor="close-shop-confirm">
            Close this shop — type <strong>{shopName}</strong> to confirm
          </Label>
          <Input
            id="close-shop-confirm"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="destructive"
            disabled={busy || confirmName.trim() !== shopName}
            onClick={() => void onClose()}
          >
            {busy ? "Closing…" : "Close this shop"}
          </Button>
          <p className="text-xs text-muted-foreground">
            After closing you have {SHOP_CLOSE_GRACE_DAYS} days to reopen. Then
            personal data is permanently erased; anonymised order totals are
            kept for UK tax (6 years).
          </p>
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {message ? (
        <p className="text-sm text-muted-foreground">{message}</p>
      ) : null}
    </section>
  );
}
