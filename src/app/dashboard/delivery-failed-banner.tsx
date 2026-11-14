"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function DeliveryFailedBanner({
  count,
  latestErrorText,
}: {
  count: number;
  latestErrorText: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (count <= 0 || hidden) return null;

  const label =
    count === 1
      ? "1 message could not be delivered"
      : `${count} messages could not be delivered`;

  async function dismiss() {
    setError(null);
    setPending(true);
    try {
      const response = await fetch(
        "/api/dashboard/delivery-failures/acknowledge",
        { method: "POST" },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error ?? "Could not dismiss");
      }
      setHidden(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(false);
    }
  }

  return (
    <div
      role="alert"
      className="border-b border-red-800/50 bg-red-600 px-4 py-3 text-white md:px-6"
    >
      <p className="text-sm font-semibold tracking-tight">{label}</p>
      <p className="mt-1 text-sm text-red-50">
        {latestErrorText ? `Latest: ${latestErrorText}. ` : null}
        Buyers may be waiting — check the Inbox for messages marked
        &ldquo;Not delivered&rdquo;, &ldquo;Expired&rdquo;, or
        &ldquo;Processing failed&rdquo;. Banner stays until you dismiss or
        reply in the thread.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link
          href="/dashboard/inbox"
          className="inline-flex h-9 items-center rounded-lg bg-white px-3 text-sm font-semibold text-red-700"
        >
          Open Inbox
        </Link>
        <button
          type="button"
          onClick={() => void dismiss()}
          disabled={pending}
          className="inline-flex h-9 items-center rounded-lg border border-white/70 px-3 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
      {error ? <p className="mt-2 text-sm text-red-100">{error}</p> : null}
    </div>
  );
}
