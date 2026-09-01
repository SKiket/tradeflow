"use client";

import { useState } from "react";
import Link from "next/link";

export function BillingPausedBanner({
  title,
  body,
  hasCustomer,
}: {
  title: string;
  body: string;
  hasCustomer: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/dashboard/billing-portal", {
        method: "POST",
      });
      const result = await response.json();
      if (!response.ok || !result.url) {
        throw new Error(result.error ?? "Could not open billing.");
      }
      window.location.href = result.url;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(false);
    }
  }

  return (
    <div
      role="alert"
      className="border-b border-amber-800/40 bg-amber-100 px-4 py-3 text-amber-950 md:px-6"
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm">{body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {hasCustomer ? (
          <button
            type="button"
            onClick={() => void openPortal()}
            disabled={pending}
            className="inline-flex h-9 items-center rounded-lg bg-amber-950 px-3 text-sm font-medium text-amber-50 disabled:opacity-60"
          >
            {pending ? "Opening…" : "Manage billing"}
          </button>
        ) : (
          <Link
            href="/dashboard/settings#billing"
            className="inline-flex h-9 items-center rounded-lg bg-amber-950 px-3 text-sm font-medium text-amber-50"
          >
            Manage billing
          </Link>
        )}
        <Link
          href="/dashboard/settings#billing"
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          Billing settings
        </Link>
      </div>
      {error ? <p className="mt-2 text-sm text-red-800">{error}</p> : null}
    </div>
  );
}
