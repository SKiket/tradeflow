import { redirect } from "next/navigation";

import { getPostAuthPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

import { OnboardingWizard, type OnboardingStep } from "./onboarding-wizard";

type OnboardingPageProps = {
  searchParams: Promise<{ step?: string; add?: string }>;
};

export default async function OnboardingPage({
  searchParams,
}: OnboardingPageProps) {
  const supabase = await createClient();
  const destination = await getPostAuthPath(supabase);
  const { step, add } = await searchParams;
  const addingAnother = add === "1";
  const initialStep: OnboardingStep =
    step === "B" || step === "C" || step === "D" ? step : "A";

  if (destination === "/login") redirect("/login");
  if (destination === "/dashboard" && !step && !addingAnother) {
    redirect("/dashboard");
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <OnboardingWizard
        initialStep={initialStep}
        addingAnother={addingAnother}
      />
    </main>
  );
}
