import Link from "next/link";

export function OpenDisputesBanner({ count }: { count: number }) {
  if (count <= 0) return null;

  const label =
    count === 1
      ? "1 payment dispute needs your attention"
      : `${count} payment disputes need your attention`;

  return (
    <div
      role="alert"
      className="border-b border-amber-800/40 bg-amber-50 px-4 py-3 text-amber-950 md:px-6"
    >
      <p className="text-sm font-semibold tracking-tight">{label}</p>
      <p className="mt-1 text-sm text-amber-900/90">
        Review the evidence pack, add any notes, and confirm before the
        deadline. If a dispute is lost, the disputed amount and Stripe dispute
        fee come out of your payouts.
      </p>
      <div className="mt-3">
        <Link
          href="/dashboard/disputes"
          className="inline-flex h-9 items-center rounded-lg bg-amber-900 px-3 text-sm font-semibold text-amber-50"
        >
          Open Disputes
        </Link>
      </div>
    </div>
  );
}
