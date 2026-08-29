"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import {
  stripePaymentsStatus,
  whatsappConnectionStatus,
} from "@/lib/settings/status";

const AI_TONES = ["friendly", "professional", "concise", "warm"] as const;

export type SettingsFormValues = {
  id: string;
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
    const { error: updateError } = await supabase
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
      })
      .eq("id", business.id);

    setPending(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setSuccess("Settings saved.");
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <form onSubmit={handleSubmit} className="space-y-6">
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

        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </form>

      <section className="space-y-3 rounded-xl border p-4">
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
        <p className="font-mono text-xs text-muted-foreground">
          {business.stripe_connected_account_id
            ? `Account ${business.stripe_connected_account_id}`
            : "No connected account ID"}
        </p>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          WhatsApp
        </h2>
        <p className="text-sm font-medium">{whatsapp.headline}</p>
        <p className="text-sm text-muted-foreground">{whatsapp.detail}</p>
      </section>
    </div>
  );
}
