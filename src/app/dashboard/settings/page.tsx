import { sellerBillingStatus } from "@/lib/stripe/billing";
import { DEFAULT_RETURN_WINDOW_DAYS } from "@/lib/orders/return-window";
import { storefrontUrl } from "@/lib/storefront/url";

import { SettingsForm, type SettingsFormValues } from "./settings-form";
import { requireSeller } from "../require-seller";

type SettingsPageProps = {
  searchParams: Promise<{ billing?: string }>;
};

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const { supabase, businessId } = await requireSeller();
  const { billing } = await searchParams;
  const { data, error } = await supabase
    .from("businesses")
    .select(
      "id, slug, name, logo_url, banner_url, dispatch_address_line1, dispatch_city, dispatch_postcode, returns_policy_text, return_window_days, ai_tone, default_low_stock_threshold, stripe_connected_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, trial_ends_at, whatsapp_phone_e164, storefront_accent_color",
    )
    .eq("id", businessId)
    .maybeSingle();

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Settings</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load settings. {error.message}
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Settings</h1>
        <p className="text-sm text-muted-foreground">Business not found.</p>
      </div>
    );
  }

  const business: SettingsFormValues = {
    id: data.id as string,
    storefrontUrl: storefrontUrl(data.slug as string),
    name: data.name as string,
    dispatch_address_line1:
      (data.dispatch_address_line1 as string | null) ?? null,
    dispatch_city: (data.dispatch_city as string | null) ?? null,
    dispatch_postcode: (data.dispatch_postcode as string | null) ?? null,
    returns_policy_text: (data.returns_policy_text as string | null) ?? null,
    return_window_days:
      (data.return_window_days as number | null) ?? DEFAULT_RETURN_WINDOW_DAYS,
    ai_tone: (data.ai_tone as string) || "friendly",
    default_low_stock_threshold:
      (data.default_low_stock_threshold as number | null) ?? 5,
    stripe_connected_account_id:
      (data.stripe_connected_account_id as string | null) ?? null,
    stripe_charges_enabled: Boolean(data.stripe_charges_enabled),
    stripe_payouts_enabled: Boolean(data.stripe_payouts_enabled),
    stripe_details_submitted: Boolean(data.stripe_details_submitted),
    whatsapp_phone_e164: (data.whatsapp_phone_e164 as string | null) ?? null,
    storefront_accent_color:
      (data.storefront_accent_color as string | null) ?? null,
    logo_url: (data.logo_url as string | null) ?? null,
    banner_url: (data.banner_url as string | null) ?? null,
    stripe_customer_id: (data.stripe_customer_id as string | null) ?? null,
    stripe_subscription_id:
      (data.stripe_subscription_id as string | null) ?? null,
    stripe_subscription_status:
      (data.stripe_subscription_status as string | null) ?? null,
    trial_ends_at: (data.trial_ends_at as string | null) ?? null,
    billingNotice:
      billing === "success"
        ? "Trial started — Stripe will confirm your subscription shortly."
        : billing === "cancelled"
          ? "Checkout was cancelled. You can start the trial again whenever you’re ready."
          : null,
    billingCopy: sellerBillingStatus({
      customerId: (data.stripe_customer_id as string | null) ?? null,
      status: (data.stripe_subscription_status as string | null) ?? null,
      trialEndsAt: (data.trial_ends_at as string | null) ?? null,
    }),
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="tf-page-heading">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Your business details, payment status, and WhatsApp connection.
        </p>
      </div>
      <SettingsForm business={business} />
    </div>
  );
}
