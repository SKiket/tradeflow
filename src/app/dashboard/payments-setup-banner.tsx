import Link from "next/link";

/** Seller banner when Connect cannot take destination card payments yet. */
export function PaymentsSetupBanner() {
  return (
    <div
      role="status"
      className="border-b border-sky-800/30 bg-sky-50 px-4 py-3 text-sky-950 md:px-6"
    >
      <p className="text-sm font-semibold">Finish your payment setup</p>
      <p className="mt-1 text-sm text-sky-900/90">
        Buyers cannot pay by card until Stripe charges and transfers are
        enabled.{" "}
        <Link
          href="/dashboard/settings#stripe"
          className="font-medium underline underline-offset-2"
        >
          Continue Stripe onboarding
        </Link>
        .
      </p>
    </div>
  );
}
