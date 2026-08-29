import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function presentedCronSecret(request: NextRequest): string | null {
  const header =
    request.headers.get("x-cron-secret") ??
    request.headers.get("x-cron-shared-secret");
  const bearer = request.headers.get("authorization");
  const bearerToken = bearer?.toLowerCase().startsWith("bearer ")
    ? bearer.slice(7).trim()
    : null;
  const query = request.nextUrl.searchParams.get("secret");
  const presented = header ?? bearerToken ?? query;
  return presented && presented.length > 0 ? presented : null;
}

/**
 * Shared-secret gate for scheduled cron routes.
 *
 * Accepts the secret as `x-cron-secret` / `Authorization: Bearer …` header
 * or `?secret=` query param (pg_net can pass either).
 *
 * Checks CRON_SHARED_SECRET first, then the same value in Supabase vault
 * (`cron_shared_secret`) so pg_cron can authenticate against production
 * even if the Vercel env var has not been set yet.
 */
export async function authorizeCronRequest(
  request: NextRequest,
): Promise<boolean> {
  const presented = presentedCronSecret(request);
  if (!presented) return false;

  const expected = process.env.CRON_SHARED_SECRET;
  if (expected && secretsEqual(presented, expected)) {
    return true;
  }

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("cron_secret_matches", {
      p_secret: presented,
    });
    if (error) {
      console.error("[cron] vault secret check failed", error.message);
      return false;
    }
    return data === true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron] vault secret check threw", message);
    return false;
  }
}
