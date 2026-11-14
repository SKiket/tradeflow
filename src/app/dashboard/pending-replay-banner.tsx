import Link from "next/link";

export function PendingReplayBanner({ count }: { count: number }) {
  if (count <= 0) return null;

  const label =
    count === 1
      ? "1 buyer message is waiting to be answered"
      : `${count} buyer messages are waiting to be answered`;

  return (
    <div
      role="alert"
      className="border-b border-amber-900/40 bg-amber-500 px-4 py-3 text-amber-950 md:px-6"
    >
      <p className="text-sm font-semibold tracking-tight">{label}</p>
      <p className="mt-1 text-sm">
        These WhatsApp messages could not be answered (often a send limit).
        TradeFlow will retry automatically — open the Inbox to review.
      </p>
      <div className="mt-3">
        <Link
          href="/dashboard/inbox"
          className="inline-flex h-9 items-center rounded-lg bg-amber-950 px-3 text-sm font-semibold text-amber-50"
        >
          Open Inbox
        </Link>
      </div>
    </div>
  );
}
