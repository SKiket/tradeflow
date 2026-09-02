"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { COPALLA_PRIVACY_URL, COPALLA_TERMS_URL } from "@/lib/legal";
import { slugify } from "@/lib/slug";
import { createClient } from "@/lib/supabase/client";

export type OnboardingStep = "A" | "B" | "C" | "D";

type FormData = {
  name: string;
  slug: string;
  dispatch_address_line1: string;
  dispatch_city: string;
  dispatch_postcode: string;
};

const STEPS: OnboardingStep[] = ["A", "B", "C", "D"];

const ONBOARDING_BUSINESS_KEY = "tf_onboarding_business_id";

export function OnboardingWizard({
  initialStep = "A",
  addingAnother = false,
}: {
  initialStep?: OnboardingStep;
  addingAnother?: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);
  const [slugChecking, setSlugChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [startingTrial, setStartingTrial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>({
    name: "",
    slug: "",
    dispatch_address_line1: "",
    dispatch_city: "",
    dispatch_postcode: "",
  });

  const checkSlug = useCallback(async (slug: string) => {
    if (!slug) {
      setSlugAvailable(null);
      return;
    }
    setSlugChecking(true);
    const response = await fetch(
      `/api/onboarding/slug-available?slug=${encodeURIComponent(slug)}`,
    );
    const result = await response.json();
    setSlugAvailable(result.available === true);
    setSlugChecking(false);
  }, []);

  useEffect(() => {
    if (initialStep === "A") {
      sessionStorage.removeItem(ONBOARDING_BUSINESS_KEY);
    }
  }, [initialStep]);

  useEffect(() => {
    if (step !== "A" || !form.slug) return;
    const timer = setTimeout(() => checkSlug(form.slug), 300);
    return () => clearTimeout(timer);
  }, [form.slug, step, checkSlug]);

  function updateField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "name" && !slugTouched) {
        next.slug = slugify(value);
      }
      return next;
    });
  }

  function canContinue(): boolean {
    switch (step) {
      case "A":
        return (
          form.name.trim().length > 0 &&
          form.slug.trim().length > 0 &&
          slugAvailable === true &&
          !slugChecking
        );
      case "B":
        return (
          form.dispatch_address_line1.trim().length > 0 &&
          form.dispatch_city.trim().length > 0 &&
          form.dispatch_postcode.trim().length > 0
        );
      case "C":
        // Bank connection via Stripe is optional at onboarding time — sellers
        // can connect now or complete it later from their dashboard.
        return true;
      case "D":
        return true;
      default:
        return false;
    }
  }

  function goNext() {
    const index = STEPS.indexOf(step);
    if (index < STEPS.length - 1) {
      setStep(STEPS[index + 1]!);
      setError(null);
    }
  }

  function goBack() {
    const index = STEPS.indexOf(step);
    if (index > 0) {
      setStep(STEPS[index - 1]!);
      setError(null);
    }
  }

  async function setActiveBusiness(businessId: string): Promise<boolean> {
    const response = await fetch("/api/dashboard/active-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setError(
        typeof result.error === "string"
          ? result.error
          : "Could not select this shop.",
      );
      return false;
    }
    return true;
  }

  // Creates the business row for this wizard session. First-time sign-up
  // reuses an existing row if the user already has one (retry-safe). Adding
  // another shop always inserts a new row, using sessionStorage so a Stripe
  // round-trip does not create a third shop.
  async function ensureBusiness(): Promise<boolean> {
    const storedId = sessionStorage.getItem(ONBOARDING_BUSINESS_KEY);
    if (storedId) {
      return setActiveBusiness(storedId);
    }

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setError("Session expired. Please sign in again.");
      router.push("/login");
      return false;
    }

    if (!addingAnother) {
      const { data: existing } = await supabase
        .from("businesses")
        .select("id")
        .eq("owner_user_id", user.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        sessionStorage.setItem(ONBOARDING_BUSINESS_KEY, existing.id as string);
        return setActiveBusiness(existing.id as string);
      }
    }

    const name = form.name.trim();
    const slug = form.slug.trim();
    if (!name || !slug) {
      setError("Enter a business name and slug first.");
      setStep("A");
      return false;
    }

    const { data: created, error: insertError } = await supabase
      .from("businesses")
      .insert({
        owner_user_id: user.id,
        name,
        slug,
        dispatch_address_line1: form.dispatch_address_line1.trim(),
        dispatch_city: form.dispatch_city.trim(),
        dispatch_postcode: form.dispatch_postcode.trim(),
      })
      .select("id")
      .single();

    if (insertError || !created) {
      setError(insertError?.message ?? "Could not create this shop.");
      return false;
    }

    sessionStorage.setItem(ONBOARDING_BUSINESS_KEY, created.id as string);
    return setActiveBusiness(created.id as string);
  }

  // Persists the business (if needed) then redirects into Stripe's hosted
  // Express onboarding so Stripe collects and verifies bank details directly.
  async function connectBank() {
    setConnecting(true);
    setError(null);

    if (!(await ensureBusiness())) {
      setConnecting(false);
      return;
    }

    const response = await fetch("/api/onboarding/stripe-connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ add: addingAnother }),
    });
    const result = await response.json();

    if (!response.ok || !result.url) {
      setError(result.error ?? "Could not start Stripe onboarding.");
      setConnecting(false);
      return;
    }

    window.location.href = result.url;
  }

  async function startTrial() {
    setStartingTrial(true);
    setError(null);

    if (!(await ensureBusiness())) {
      setStartingTrial(false);
      return;
    }

    const response = await fetch("/api/onboarding/billing-checkout", {
      method: "POST",
    });
    const result = await response.json();

    if (!response.ok || !result.url) {
      setError(result.error ?? "Could not start your free trial.");
      setStartingTrial(false);
      return;
    }

    window.location.href = result.url;
  }

  const stepIndex = STEPS.indexOf(step) + 1;

  return (
    <div className="w-full max-w-md space-y-6">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step {stepIndex} of {STEPS.length}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {addingAnother ? "Add another shop" : "Set up your business"}
        </h1>
        {addingAnother ? (
          <p className="text-sm text-muted-foreground">
            <a href="/dashboard/orders" className="underline-offset-4 hover:underline">
              Back to dashboard
            </a>
          </p>
        ) : null}
      </div>

      {step === "A" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Business name</Label>
            <Input
              id="name"
              value={form.name}
              onChange={(event) => updateField("name", event.target.value)}
              placeholder="Acme Crafts"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slug">URL slug</Label>
            <Input
              id="slug"
              value={form.slug}
              onChange={(event) => {
                setSlugTouched(true);
                updateField("slug", slugify(event.target.value));
              }}
              placeholder="acme-crafts"
              required
            />
            {slugChecking && (
              <p className="text-xs text-muted-foreground">
                Checking availability…
              </p>
            )}
            {!slugChecking && slugAvailable === true && form.slug && (
              <p className="text-xs text-green-600">Slug is available</p>
            )}
            {!slugChecking && slugAvailable === false && (
              <p className="text-xs text-destructive">
                This slug is already taken
              </p>
            )}
          </div>
        </div>
      )}

      {step === "B" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="line1">Dispatch address line 1</Label>
            <Input
              id="line1"
              value={form.dispatch_address_line1}
              onChange={(event) =>
                updateField("dispatch_address_line1", event.target.value)
              }
              placeholder="123 High Street"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              value={form.dispatch_city}
              onChange={(event) =>
                updateField("dispatch_city", event.target.value)
              }
              placeholder="London"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="postcode">Postcode</Label>
            <Input
              id="postcode"
              value={form.dispatch_postcode}
              onChange={(event) =>
                updateField("dispatch_postcode", event.target.value)
              }
              placeholder="SW1A 1AA"
              required
            />
          </div>
        </div>
      )}

      {step === "C" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-6 space-y-3">
            <h2 className="font-medium">Get paid with Stripe</h2>
            <p className="text-sm text-muted-foreground">
              Connect your bank securely through Stripe. Stripe collects and
              verifies your details directly — TradeFlow never stores your raw
              bank information. This is how buyers pay you.
            </p>
            <Button
              type="button"
              className="w-full"
              disabled={connecting}
              onClick={connectBank}
            >
              {connecting ? "Redirecting to Stripe…" : "Connect your bank via Stripe"}
            </Button>
            <p className="text-xs text-muted-foreground">
              You can also connect later from your dashboard.
            </p>
          </div>
        </div>
      )}

      {step === "D" && (
        <div className="rounded-lg border border-border p-6 space-y-3">
          <h2 className="font-medium">Start your free trial</h2>
          <p className="text-sm text-muted-foreground">
            30 days free. A card is required now, but you are not charged during
            the trial — the £10/month plan and the 1% per-order fee are both
            waived until it ends.
          </p>
          <p className="text-xs text-muted-foreground">
            After the trial: £10/month plus 1% of each order, taken from the
            buyer payment via Stripe Connect. WhatsApp inbox setup comes later
            from your dashboard.
          </p>
          <Button
            type="button"
            className="w-full"
            disabled={startingTrial}
            onClick={startTrial}
          >
            {startingTrial ? "Redirecting to Stripe…" : "Start 30-day free trial"}
          </Button>
          <p className="text-xs text-muted-foreground">
            By starting a trial you agree to our{" "}
            <a
              href={COPALLA_TERMS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Terms
            </a>{" "}
            and{" "}
            <a
              href={COPALLA_PRIVACY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Privacy Policy
            </a>.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-3">
        {step !== "A" && (
          <Button type="button" variant="outline" onClick={goBack}>
            Back
          </Button>
        )}
        {step !== "D" && (
          <Button
            type="button"
            className="flex-1"
            disabled={!canContinue()}
            onClick={goNext}
          >
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
