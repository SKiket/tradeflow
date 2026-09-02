import { cache } from "react";
import { redirect } from "next/navigation";

import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { createClient } from "@/lib/supabase/server";

export const requireSeller = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { business, businesses, error } = await resolveActiveOwnedBusiness(
    supabase,
    user.id,
  );

  if (error || !business) redirect("/onboarding");

  return {
    supabase,
    user,
    businessId: business.id,
    business,
    businesses,
  };
});
