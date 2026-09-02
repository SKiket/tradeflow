import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/**
 * UX convenience only — not a security boundary. RLS still decides which
 * rows a signed-in owner can read or write. Always resolve this cookie
 * against businesses the user actually owns before using it.
 */
export const ACTIVE_BUSINESS_COOKIE = "active_business_id";

export const ACTIVE_BUSINESS_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 400,
  secure: process.env.NODE_ENV === "production",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseBusinessId(
  value: string | undefined | null,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !UUID_RE.test(trimmed)) return undefined;
  return trimmed;
}

export const OWNED_BUSINESS_SELECT =
  "id, name, slug, created_at, stripe_connected_account_id, stripe_customer_id, stripe_subscription_status, trial_ends_at";

export type OwnedBusiness = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  stripe_connected_account_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_status: string | null;
  trial_ends_at: string | null;
};

export function pickActiveBusiness<T extends { id: string }>(
  businesses: T[],
  requestedId: string | undefined,
): T | null {
  if (businesses.length === 0) return null;
  if (requestedId) {
    const match = businesses.find((row) => row.id === requestedId);
    if (match) return match;
  }
  return businesses[0]!;
}

export async function readActiveBusinessCookie(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return parseBusinessId(cookieStore.get(ACTIVE_BUSINESS_COOKIE)?.value);
}

export async function loadOwnedBusinesses(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ businesses: OwnedBusiness[]; error: string | null }> {
  const { data, error } = await supabase
    .from("businesses")
    .select(OWNED_BUSINESS_SELECT)
    .eq("owner_user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) return { businesses: [], error: error.message };
  return { businesses: (data ?? []) as OwnedBusiness[], error: null };
}

export async function resolveActiveOwnedBusiness(
  supabase: SupabaseClient,
  userId: string,
  requestedId?: string,
): Promise<{
  business: OwnedBusiness | null;
  businesses: OwnedBusiness[];
  error: string | null;
}> {
  const { businesses, error } = await loadOwnedBusinesses(supabase, userId);
  if (error) return { business: null, businesses: [], error };
  const cookieId = requestedId ?? (await readActiveBusinessCookie());
  return {
    business: pickActiveBusiness(businesses, cookieId),
    businesses,
    error: null,
  };
}
