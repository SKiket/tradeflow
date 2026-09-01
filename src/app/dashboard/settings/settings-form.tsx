"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  parseAccentHex,
  resolveStorefrontAccent,
  STOREFRONT_ACCENT_PRESETS,
  accentForeground,
} from "@/lib/brand/accent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ImageUpload } from "@/components/upload/image-upload";
import { BUSINESS_BRANDING_BUCKET } from "@/lib/storage/upload";
import { createClient } from "@/lib/supabase/client";
import {
  stripePaymentsStatus,
  whatsappConnectionStatus,
} from "@/lib/settings/status";

const AI_TONES = ["friendly", "professional", "concise", "warm"] as const;

export type SettingsFormValues = {
  id: string;
  storefrontUrl: string;
  name: string;
  dispatch_address_line1: string | null;
  dispatch_city: string | null;
  dispatch_postcode: string | null;
  returns_policy_text: string | null;
  ai_tone: string;
  default_low_stock_threshold: number;
  stripe_connected_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_details_submitted: boolean;
  whatsapp_phone_e164: string | null;
  storefront_accent_color: string | null;
  logo_url: string | null;
  banner_url: string | null;
};

function parseThreshold(value: string, fallback: number) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

export function SettingsForm({ business }: { business: SettingsFormValues }) {
  const router = useRouter();
  const [name, setName] = useState(business.name);
  const [line1, setLine1] = useState(business.dispatch_address_line1 ?? "");
  const [city, setCity] = useState(business.dispatch_city ?? "");
  const [postcode, setPostcode] = useState(business.dispatch_postcode ?? "");
  const [returnsPolicy, setReturnsPolicy] = useState(
    business.returns_policy_text ?? "",
  );
  const [aiTone, setAiTone] = useState(business.ai_tone || "friendly");
  const [lowStock, setLowStock] = useState(
    String(business.default_low_stock_threshold ?? 5),
  );
  const [accent, setAccent] = useState<string>(
    parseAccentHex(business.storefront_accent_color) ?? "",
  );
  const [logoUrl, setLogoUrl] = useState<string | null>(business.logo_url);
  const [bannerUrl, setBannerUrl] = useState<string | null>(business.banner_url);
  const [logoUploading, setLogoUploading] = useState(false);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const returnsEmpty = returnsPolicy.trim().length === 0;
  const toneOptions = AI_TONES.includes(aiTone as (typeof AI_TONES)[number])
    ? AI_TONES
    : ([aiTone, ...AI_TONES] as string[]);

  const stripe = stripePaymentsStatus({
    connectedAccountId: business.stripe_connected_account_id,
    chargesEnabled: business.stripe_charges_enabled,
    payoutsEnabled: business.stripe_payouts_enabled,
    detailsSubmitted: business.stripe_details_submitted,
  });
  const whatsapp = whatsappConnectionStatus(business.whatsapp_phone_e164);
  const brandingUploading = logoUploading || bannerUploading;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Business name is required.");
      return;
    }

    setPending(true);
    const supabase = createClient();
    try {
      const { data, error: updateError } = await supabase
        .from("businesses")
        .update({
          name: trimmedName,
          dispatch_address_line1: line1.trim() || null,
          dispatch_city: city.trim() || null,
          dispatch_postcode: postcode.trim() || null,
          returns_policy_text: returnsPolicy.trim() || null,
          ai_tone: aiTone.trim() || "friendly",
          default_low_stock_threshold: parseThreshold(
            lowStock,
            business.default_low_stock_threshold ?? 5,
          ),
          storefront_accent_color: parseAccentHex(accent),
          logo_url: logoUrl?.trim() || null,
          banner_url: bannerUrl?.trim() || null,
        })
        .eq("id", business.id)
        .select("id")
        .maybeSingle();

      if (updateError) throw new Error(updateError.message);
      if (!data) throw new Error("Couldn't save settings.");
      setSuccess("Settings saved.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Storefront
          </h2>
          <p className="text-sm text-muted-foreground">
            Share this link so buyers can browse your catalog and order on
            WhatsApp. No login required.
          </p>
          <a
            href={business.storefrontUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block break-all text-sm text-foreground underline-offset-4 hover:underline"
          >
            {business.storefrontUrl}
          </a>
          <AccentPicker value={accent} onChange={setAccent} disabled={pending} />
          <ImageUpload
            label="Logo"
            hint="Shown in the storefront header. JPEG, PNG, WebP, or GIF. Maximum 5 MB."
            value={logoUrl}
            onChange={setLogoUrl}
            businessId={business.id}
            bucket={BUSINESS_BRANDING_BUCKET}
            prefix="logo"
            previewClassName="size-28"
            disabled={pending}
            onUploadingChange={setLogoUploading}
          />
          <ImageUpload
            label="Banner"
            hint="Shown at the top of your storefront. JPEG, PNG, WebP, or GIF. Maximum 5 MB."
            value={bannerUrl}
            onChange={setBannerUrl}
            businessId={business.id}
            bucket={BUSINESS_BRANDING_BUCKET}
            prefix="banner"
            previewClassName="aspect-[3/1] w-full max-w-lg"
            disabled={pending}
            onUploadingChange={setBannerUploading}
          />
        </section>

        <section className="space-y-4 rounded-xl border p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Business
          </h2>
          <div className="space-y-1">
            <Label htmlFor="business-name">Business name</Label>
            <Input
              id="business-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              disabled={pending}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dispatch-line1">Dispatch address</Label>
            <Input
              id="dispatch-line1"
              value={line1}
              onChange={(event) => setLine1(event.target.value)}
              placeholder="Address line 1"
              disabled={pending}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="dispatch-city">City</Label>
              <Input
                id="dispatch-city"
                value={city}
                onChange={(event) => setCity(event.target.value)}
                disabled={pending}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dispatch-postcode">Postcode</Label>
              <Input
                id="dispatch-postcode"
                value={postcode}
                onChange={(event) => setPostcode(event.target.value)}
                disabled={pending}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-tone">AI tone</Label>
            <select
              id="ai-tone"
              value={aiTone}
              onChange={(event) => setAiTone(event.target.value)}
              disabled={pending}
              className="flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {toneOptions.map((tone) => (
                <option key={tone} value={tone}>
                  {tone.charAt(0).toUpperCase() + tone.slice(1)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Used when answering buyer questions over WhatsApp.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="returns-policy">Returns policy</Label>
            <textarea
              id="returns-policy"
              value={returnsPolicy}
              onChange={(event) => setReturnsPolicy(event.target.value)}
              disabled={pending}
              rows={4}
              className="flex w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {returnsEmpty && (
              <p className="text-xs text-amber-800">
                If this is empty, WhatsApp questions about returns cannot be
                answered automatically and will be passed to you instead.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="low-stock">Default low-stock threshold</Label>
            <Input
              id="low-stock"
              type="number"
              min="0"
              step="1"
              value={lowStock}
              onChange={(event) => setLowStock(event.target.value)}
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              Starting value for new product variants. Existing variants keep
              their own threshold.
            </p>
          </div>
        </section>

        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {success && !error && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {success}
          </p>
        )}

        <Button type="submit" disabled={pending || brandingUploading}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </form>

      <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Stripe
        </h2>
        <p className="text-sm font-medium">{stripe.headline}</p>
        <p className="text-sm text-muted-foreground">{stripe.detail}</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Charges</dt>
            <dd>{business.stripe_charges_enabled ? "Enabled" : "Off"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Payouts</dt>
            <dd>{business.stripe_payouts_enabled ? "Enabled" : "Off"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Details submitted</dt>
            <dd>{business.stripe_details_submitted ? "Yes" : "No"}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          {business.stripe_connected_account_id
            ? `Account ${business.stripe_connected_account_id}`
            : "No connected account ID"}
        </p>
      </section>

      <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          WhatsApp
        </h2>
        <p className="text-sm font-medium">{whatsapp.headline}</p>
        <p className="text-sm text-muted-foreground">{whatsapp.detail}</p>
      </section>
    </div>
  );
}

function AccentPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  const parsed = parseAccentHex(value);
  const preview = resolveStorefrontAccent(parsed);
  const previewText = accentForeground(preview);
  const isDefault = parsed === null;

  return (
    <div className="space-y-2 pt-2">
      <Label>Shop accent colour</Label>
      <p className="text-xs text-muted-foreground">
        Used on your public storefront&apos;s buttons. Leave as TradeFlow amber
        unless you want a colour of your own. Save settings to apply.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {STOREFRONT_ACCENT_PRESETS.map((preset) => {
          const selected =
            preset.value === null ? isDefault : parsed === preset.value;
          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={preset.label}
              title={preset.label}
              onClick={() => onChange(preset.value ?? "")}
              className={`size-8 rounded-full border-2 ${
                selected ? "border-foreground" : "border-transparent"
              } disabled:opacity-50`}
              style={{
                backgroundColor: preset.value ?? "#F5C518",
              }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          id="storefront-accent"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="#F5C518"
          disabled={disabled}
          className="max-w-[10rem]"
          aria-label="Custom accent hex"
        />
        <span
          className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold"
          style={{ backgroundColor: preview, color: previewText }}
        >
          Add to cart
        </span>
      </div>
    </div>
  );
}
