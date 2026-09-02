import Link from "next/link";

import { LegalLinks } from "@/components/brand/legal-links";
import { fetchSetupProgress } from "@/lib/dashboard/setup-progress";
import { canAcceptOrders, ordersPausedBanner } from "@/lib/stripe/billing-gate";

import { BillingPausedBanner } from "./billing-paused-banner";
import { BusinessSwitcher } from "./business-switcher";
import { DashboardNav } from "./dashboard-nav";
import { requireSeller } from "./require-seller";
import { SetupChecklist } from "./setup-checklist";
import { SignOutButton } from "./sign-out-button";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { supabase, business, businesses } = await requireSeller();
  const setupProgress = await fetchSetupProgress(supabase, business.id);

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

  const switcherBusinesses = businesses.map((row) => ({
    id: row.id,
    name: row.name,
  }));

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
          <BusinessSwitcher
            businesses={switcherBusinesses}
            activeId={business.id}
            variant="sidebar"
          />
        </div>
        <div className="flex-1 p-3">
          <DashboardNav orientation="side" />
        </div>
        <LegalLinks
          className="border-t border-sidebar-border px-4 py-3 text-[11px] text-sidebar-foreground/50"
          linkClassName="underline-offset-2 hover:underline"
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
          <div className="min-w-0 md:hidden">
            <BusinessSwitcher
              businesses={switcherBusinesses}
              activeId={business.id}
              variant="header"
            />
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
        <main className="flex-1 p-4 md:p-6">
          {setupProgress ? <SetupChecklist progress={setupProgress} /> : null}
          {children}
        </main>
        <LegalLinks
          className="border-t px-4 py-3 text-center text-[11px] text-muted-foreground md:hidden"
          linkClassName="underline-offset-2 hover:underline"
        />
      </div>
    </div>
  );
}
