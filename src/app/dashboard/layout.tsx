import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { DashboardNav } from "./dashboard-nav";
import { SignOutButton } from "./sign-out-button";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
    <div className="flex min-h-full flex-1 bg-background">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="border-b border-sidebar-border px-4 py-4">
          <p className="text-sm font-semibold tracking-tight">TradeFlow</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {business.name}
          </p>
        </div>
        <div className="flex-1 p-3">
          <DashboardNav orientation="side" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
          <div className="min-w-0 md:hidden">
            <p className="truncate text-sm font-semibold">{business.name}</p>
          </div>
          <p className="hidden truncate text-sm font-medium md:block">
            {business.name}
          </p>
          <SignOutButton />
        </header>
        <div className="border-b px-2 py-2 md:hidden">
          <DashboardNav orientation="top" />
        </div>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
