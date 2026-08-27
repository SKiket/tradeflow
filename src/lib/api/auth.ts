import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Supabase client for authenticated API routes.
 * Supports session cookies (browser) or `Authorization: Bearer <token>` (curl/Postman).
 */
export async function createAuthedClient(
  request: NextRequest,
): Promise<Awaited<ReturnType<typeof createClient>>> {
  const bearer = request.headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    const token = bearer.slice(7).trim();
    const cookieStore = await cookies();
    return createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {
            // Bearer auth — no cookie writes from route handlers.
          },
        },
        global: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
  }
  return createClient();
}

export async function requireUser(
  request: NextRequest,
): Promise<
  | { ok: true; user: User; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; status: 401 }
> {
  const supabase = await createAuthedClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, status: 401 };
  }
  return { ok: true, user, supabase };
}
