import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { SignOutButton } from "./sign-out-button";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: business } = await supabase
    .from("businesses")
    .select("name")
    .eq("owner_user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!business) redirect("/onboarding");

  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <SignOutButton />
      </header>
      <p className="mt-6 text-lg">Welcome, {business.name}</p>
    </main>
  );
}
