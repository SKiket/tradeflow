import type { SupabaseClient } from "@supabase/supabase-js";

export async function getPostAuthPath(
  supabase: SupabaseClient,
): Promise<"/dashboard" | "/onboarding" | "/login"> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return "/login";

  const { data: business } = await supabase
    .from("businesses")
    .select("id")
    .eq("owner_user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  return business ? "/dashboard" : "/onboarding";
}
