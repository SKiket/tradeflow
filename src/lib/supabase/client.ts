import { createBrowserClient } from "@supabase/ssr";

import { forceImplicitFlow, IMPLICIT_AUTH } from "@/lib/supabase/auth-options";

export function createClient() {
  return forceImplicitFlow(
    createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: IMPLICIT_AUTH },
    ),
  );
}
