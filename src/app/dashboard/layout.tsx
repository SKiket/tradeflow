import Link from "next/link";

import { LegalLinks } from "@/components/brand/legal-links";
import { countPendingReplays } from "@/lib/channels/pending-replay";
import { countRecentDeliveryFailures } from "@/lib/dashboard/delivery-failures";
import { fetchSetupProgress } from "@/lib/dashboard/setup-progress";
import { listOpenActionableFraudWarnings } from "@/lib/disputes/fraud-warnings";
import { countOpenDisputes } from "@/lib/disputes/open-disputes";
import { countOpenKnowledgeGaps } from "@/lib/knowledge/gaps";
import {
  canAcceptOrders,
  getAcceptOrdersBlockReason,
  ordersPausedBanner,
} from "@/lib/stripe/billing-gate";
import { canTakeCardPayments } from "@/lib/stripe/connect-capabilities";

import { BillingPausedBanner } from "./billing-paused-banner";
import { PaymentsSetupBanner } from "./payments-setup-banner";
import { DeliveryFailedBanner } from "./delivery-failed-banner";
import {
  NeedsAttentionBanner,
  type NeedsAttentionItem,
} from "./needs-attention-banner";
import { OpenDisputesBanner } from "./open-disputes-banner";
import { PendingReplayBanner } from "./pending-replay-banner";
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
  const deliveryFailures = await countRecentDeliveryFailures(
    supabase,
    business.id,
  );
  const pendingReplays = await countPendingReplays(supabase, business.id);
  const openDisputes = await countOpenDisputes(supabase, business.id);
  const fraudWarnings = await listOpenActionableFraudWarnings(
    supabase,
    business.id,
  );
  const { data: urgentOrders } = await supabase
    .from("orders")
    .select("id, order_ref")
    .eq("business_id", business.id)
    .not("seller_attention_urgent_at", "is", null)
    .is("deleted_at", null)
    .order("seller_attention_urgent_at", { ascending: false })
    .limit(10);

  const needsAttention: NeedsAttentionItem[] = [];
  if (openDisputes > 0) {
    needsAttention.push({
      kind: "dispute",
      href: "/dashboard/disputes",
      label:
        openDisputes === 1
          ? "1 payment dispute needs a response"
          : `${openDisputes} payment disputes need a response`,
    });
  }
  for (const fw of fraudWarnings) {
    if (!fw.orderId) continue;
    needsAttention.push({
      kind: "fraud",
      href: `/dashboard/orders/${fw.orderId}`,
      label: `Early fraud warning on ${fw.orderRef ?? "an order"}`,
    });
  }
  for (const row of urgentOrders ?? []) {
    needsAttention.push({
      kind: "complaint",
      href: `/dashboard/orders/${row.id}`,
      label: `Payment complaint on ${row.order_ref}`,
    });
  }
  const openGaps = await countOpenKnowledgeGaps(business.id, supabase);
  if (openGaps > 0) {
    needsAttention.push({
      kind: "knowledge_gap",
      href: "/dashboard/knowledge-gaps",
      label:
        openGaps === 1
          ? "1 question the AI could not answer"
          : `${openGaps} questions the AI could not answer`,
    });
  }

  const billingBusiness = {
    stripe_subscription_status:
      (business.stripe_subscription_status as string | null) ?? null,
    closed_at: (business.closed_at as string | null) ?? null,
    dispute_balance_hold:
      (business.dispute_balance_hold as boolean | null) ?? false,
  };
  const takingOrders = canAcceptOrders(billingBusiness);
  const blockReason = getAcceptOrdersBlockReason(billingBusiness);
  const paused = takingOrders
    ? null
    : ordersPausedBanner({
        status: (business.stripe_subscription_status as string | null) ?? null,
        trialEndsAt: (business.trial_ends_at as string | null) ?? null,
        blockReason,
        disputeOwedPence:
          (business.dispute_balance_owed_pence as number | null) ?? null,
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
        {!canTakeCardPayments({
          stripe_connected_account_id: business.stripe_connected_account_id,
          stripe_charges_enabled: business.stripe_charges_enabled,
          stripe_transfers_capability_active:
            business.stripe_transfers_capability_active,
        }) ? (
          <PaymentsSetupBanner />
        ) : null}
        <PendingReplayBanner count={pendingReplays} />
        <DeliveryFailedBanner
          count={deliveryFailures.count}
          latestErrorText={deliveryFailures.latestErrorText}
        />
        <NeedsAttentionBanner items={needsAttention} />
        <OpenDisputesBanner count={openDisputes} />
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
