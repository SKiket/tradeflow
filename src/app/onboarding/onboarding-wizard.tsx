"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { slugify } from "@/lib/slug";
import { createClient } from "@/lib/supabase/client";

type Step = "A" | "B" | "C" | "D";

type FormData = {
  name: string;
  slug: string;
  dispatch_address_line1: string;
  dispatch_city: string;
  dispatch_postcode: string;
  payout_account_holder_name: string;
  payout_sort_code: string;
  payout_account_number: string;
};

const STEPS: Step[] = ["A", "B", "C", "D"];

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("A");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);
  const [slugChecking, setSlugChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>({
    name: "",
    slug: "",
    dispatch_address_line1: "",
    dispatch_city: "",
    dispatch_postcode: "",
    payout_account_holder_name: "",
    payout_sort_code: "",
    payout_account_number: "",
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
        return (
          form.payout_account_holder_name.trim().length > 0 &&
          form.payout_sort_code.trim().length > 0 &&
          form.payout_account_number.trim().length > 0
        );
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

  async function completeOnboarding() {
    setSubmitting(true);
    setError(null);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setError("Session expired. Please sign in again.");
      setSubmitting(false);
      router.push("/login");
      return;
    }

    const { error: insertError } = await supabase.from("businesses").insert({
      owner_user_id: user.id,
      name: form.name.trim(),
      slug: form.slug.trim(),
      dispatch_address_line1: form.dispatch_address_line1.trim(),
      dispatch_city: form.dispatch_city.trim(),
      dispatch_postcode: form.dispatch_postcode.trim(),
      // Plain fields per Step 2 schema. Encryption-at-rest review required
      // before production (Spec Section 21 non-functional requirement).
      payout_account_holder_name: form.payout_account_holder_name.trim(),
      payout_sort_code: form.payout_sort_code.trim(),
      payout_account_number: form.payout_account_number.trim(),
    });

    setSubmitting(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  const stepIndex = STEPS.indexOf(step) + 1;

  return (
    <div className="w-full max-w-md space-y-6">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step {stepIndex} of {STEPS.length}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Set up your business
        </h1>
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
          <p className="text-sm text-muted-foreground">
            Bank details for payouts. Stored as plain fields for now.
          </p>
          <div className="space-y-2">
            <Label htmlFor="holder">Account holder name</Label>
            <Input
              id="holder"
              value={form.payout_account_holder_name}
              onChange={(event) =>
                updateField("payout_account_holder_name", event.target.value)
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sort">Sort code</Label>
            <Input
              id="sort"
              value={form.payout_sort_code}
              onChange={(event) =>
                updateField("payout_sort_code", event.target.value)
              }
              placeholder="12-34-56"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account">Account number</Label>
            <Input
              id="account"
              value={form.payout_account_number}
              onChange={(event) =>
                updateField("payout_account_number", event.target.value)
              }
              required
            />
          </div>
        </div>
      )}

      {step === "D" && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center space-y-2">
          <h2 className="font-medium">Connect WhatsApp</h2>
          <p className="text-sm text-muted-foreground">Coming soon</p>
          <p className="text-xs text-muted-foreground">
            Embedded Signup integration arrives in Phase 0 Step 6.
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
        {step !== "D" ? (
          <Button
            type="button"
            className="flex-1"
            disabled={!canContinue()}
            onClick={goNext}
          >
            Continue
          </Button>
        ) : (
          <Button
            type="button"
            className="flex-1"
            disabled={submitting}
            onClick={completeOnboarding}
          >
            {submitting ? "Creating…" : "Complete setup"}
          </Button>
        )}
      </div>
    </div>
  );
}
