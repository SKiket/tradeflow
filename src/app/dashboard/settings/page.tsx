import { storefrontUrl } from "@/lib/storefront/url";

import { SettingsForm, type SettingsFormValues } from "./settings-form";
import { requireSeller } from "../require-seller";

export default async function SettingsPage() {
  const { supabase, businessId } = await requireSeller();
  const { data, error } = await supabase
    .from("businesses")
    .select(
      "id, slug, name, dispatch_address_line1, dispatch_city, dispatch_postcode, returns_policy_text, ai_tone, default_low_stock_threshold, stripe_connected_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, whatsapp_phone_e164",
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
    ai_tone: (data.ai_tone as string) || "friendly",
    default_low_stock_threshold:
      (data.default_low_stock_threshold as number | null) ?? 5,
    stripe_connected_account_id:
      (data.stripe_connected_account_id as string | null) ?? null,
    stripe_charges_enabled: Boolean(data.stripe_charges_enabled),
    stripe_payouts_enabled: Boolean(data.stripe_payouts_enabled),
    stripe_details_submitted: Boolean(data.stripe_details_submitted),
    whatsapp_phone_e164: (data.whatsapp_phone_e164 as string | null) ?? null,
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
