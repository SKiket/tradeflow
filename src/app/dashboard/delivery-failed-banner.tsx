import Link from "next/link";

export function DeliveryFailedBanner({
  count,
  latestErrorText,
}: {
  count: number;
  latestErrorText: string | null;
}) {
  if (count <= 0) return null;

  const label =
    count === 1
      ? "1 message could not be delivered"
      : `${count} messages could not be delivered`;

  return (
    <div
      role="alert"
      className="border-b border-red-800/50 bg-red-600 px-4 py-3 text-white md:px-6"
    >
      <p className="text-sm font-semibold tracking-tight">{label}</p>
      <p className="mt-1 text-sm text-red-50">
        {latestErrorText
          ? `Latest: ${latestErrorText}. `
          : null}
        Buyers may be waiting — check the Inbox for messages marked
        &ldquo;Not delivered&rdquo;. Failures in the last 24 hours are
        counted here.
      </p>
      <div className="mt-3">
        <Link
          href="/dashboard/inbox"
          className="inline-flex h-9 items-center rounded-lg bg-white px-3 text-sm font-semibold text-red-700"
        >
          Open Inbox
        </Link>
      </div>
    </div>
  );
}
