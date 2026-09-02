"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await fetch("/api/dashboard/active-business", { method: "DELETE" });
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <Button variant="outline" size="sm" onClick={handleSignOut}>
      Sign out
    </Button>
  );
}
