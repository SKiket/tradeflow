import { redirect } from "next/navigation";

import { getPostAuthPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

import { OnboardingWizard } from "./onboarding-wizard";

export default async function OnboardingPage() {
  const supabase = await createClient();
  const destination = await getPostAuthPath(supabase);

  if (destination === "/login") redirect("/login");
  if (destination === "/dashboard") redirect("/dashboard");

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <OnboardingWizard />
    </main>
  );
}
