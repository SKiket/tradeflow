import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { BillingPausedBanner } from "./billing-paused-banner";
import { DashboardNav } from "./dashboard-nav";
import { SignOutButton } from "./sign-out-button";
import { canAcceptOrders, ordersPausedBanner } from "@/lib/stripe/billing-gate";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: business } = await supabase
    .from("businesses")
    .select("name, stripe_subscription_status, stripe_customer_id, trial_ends_at")
    .eq("owner_user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!business) redirect("/onboarding");

  const takingOrders = canAcceptOrders({
    stripe_subscription_status:
      (business.stripe_subscription_status as string | null) ?? null,
  });
  const paused = takingOrders
    ? null
    : ordersPausedBanner({
        status: (business.stripe_subscription_status as string | null) ?? null,
        trialEndsAt: (business.trial_ends_at as string | null) ?? null,
      });

  return (
    <div
      data-tf-surface="dashboard"
      className="flex min-h-full flex-1 bg-background"
    >
      <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="border-b border-sidebar-border px-4 py-4">
          <Link href="/dashboard/orders" className="block">
            {/* Wordmark: w-56 is too tight for the full dark lockup tagline. */}
            <img
              src="/brand/tradeflow-wordmark-white.svg"
              alt="TradeFlow"
              className="h-6 w-auto"
            />
          </Link>
          <p className="mt-2 truncate text-xs text-sidebar-foreground/70">
            {business.name}
          </p>
        </div>
        <div className="flex-1 p-3">
          <DashboardNav orientation="side" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
          <div className="min-w-0 md:hidden">
            <p className="truncate text-sm font-semibold">{business.name}</p>
          </div>
          <p className="hidden truncate text-sm font-medium md:block">
            {business.name}
          </p>
          <SignOutButton />
        </header>
        <div className="border-b border-sidebar-border bg-sidebar px-2 py-2 text-sidebar-foreground md:hidden">
          <DashboardNav orientation="top" />
        </div>
        {paused ? (
          <BillingPausedBanner
            title={paused.title}
            body={paused.body}
            hasCustomer={Boolean(business.stripe_customer_id)}
          />
        ) : null}
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
