"use client";

import { useState } from "react";

import {
  RETURN_REASON_LABEL,
  RETURN_REASONS,
  type ReturnReason,
} from "@/lib/orders/return-reasons";

export function RequestReturnForm({ orderRef }: { orderRef: string }) {
  const [reason, setReason] = useState<ReturnReason>("damaged_faulty");
  const [detail, setDetail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"requested" | "auto_approved" | false>(false);

  if (done === "auto_approved") {
    return (
      <p className="mt-3 text-sm text-zinc-700">
        Return approved for {orderRef}. Print your return slip — you arrange
        and pay return postage.
      </p>
    );
  }

  if (done === "requested") {
    return (
      <p className="mt-3 text-sm text-zinc-700">
        Return requested for {orderRef}. We&apos;ll let you know once the seller
        has reviewed it.
      </p>
    );
  }

  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          setPending(true);
          setError(null);
          try {
            const response = await fetch(
              `/api/t/${encodeURIComponent(orderRef)}/return`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  reason,
                  detail: detail.trim() || undefined,
                }),
              },
            );
            const json = (await response.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
              action?: string;
            };
            if (!response.ok || json.ok === false) {
              throw new Error(json.error || `Request failed (${response.status})`);
            }
            setDone(
              json.action === "auto_approved" ? "auto_approved" : "requested",
            );
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            setPending(false);
          }
        })();
      }}
    >
      <label className="block text-sm">
        <span className="font-medium text-zinc-800">Reason</span>
        <select
          className="mt-1 block w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
          value={reason}
          onChange={(event) => setReason(event.target.value as ReturnReason)}
          disabled={pending}
        >
          {RETURN_REASONS.map((value) => (
            <option key={value} value={value}>
              {RETURN_REASON_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="font-medium text-zinc-800">Details (optional)</span>
        <textarea
          className="mt-1 block w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
          rows={3}
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          disabled={pending}
          placeholder="Anything the seller should know"
        />
      </label>
      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="tf-storefront-cta inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
      >
        {pending ? "Sending…" : "Submit return request"}
      </button>
    </form>
  );
}
