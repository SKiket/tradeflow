import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export async function requireSeller() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: business } = await supabase
    .from("businesses")
    .select("id")
    .eq("owner_user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!business) redirect("/onboarding");

  return { supabase, user, businessId: business.id as string };
}
