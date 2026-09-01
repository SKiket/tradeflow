import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { forceImplicitFlow, IMPLICIT_AUTH } from "@/lib/supabase/auth-options";

export async function createClient() {
  const cookieStore = await cookies();

  return forceImplicitFlow(
    createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: IMPLICIT_AUTH,
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options),
              );
            } catch {
              // Server Component — cookie writes are handled by middleware.
            }
          },
        },
      },
    ),
  );
}
