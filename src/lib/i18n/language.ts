import type { SupabaseClient } from "@supabase/supabase-js";

import { isAffirmativeReply, isNegativeReply } from "@/lib/orders/detect-reply";
import { resolveLang, type SupportedLang } from "@/lib/i18n";

/**
 * Normalize a model-reported language to a short ISO 639-1 code, or null
 * when unknown / empty.
 */
export function normaliseLanguageCode(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "unknown" || trimmed === "und") return null;
  // Accept "fr", "fr-FR", "French", etc. — keep first two letters when latin.
  const match = trimmed.match(/^[a-z]{2}/);
  return match ? match[0] : null;
}

/**
 * Short ack / yes-no replies must never flip preferred_language.
 */
export function isSubstantiveMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isAffirmativeReply(trimmed) || isNegativeReply(trimmed)) return false;

  const normalized = trimmed
    .toLowerCase()
    .replace(/^[\s.,!?]+|[\s.,!?]+$/g, "")
    .replace(/\s+/g, " ");

  // Single short token (e.g. "ok", "ja", "si") — not enough to set language.
  if (!normalized.includes(" ") && normalized.length <= 4) return false;

  return true;
}

export async function getCustomerPreferredLanguage(
  supabase: SupabaseClient,
  customerId: string,
): Promise<SupportedLang> {
  const { data } = await supabase
    .from("customers")
    .select("preferred_language")
    .eq("id", customerId)
    .maybeSingle();
  return resolveLang(data?.preferred_language as string | null);
}

/**
 * Persist preferred_language only for substantive messages with a usable code.
 * Returns the language that should be used for the next reply (stored or prior).
 */
export async function maybeUpdatePreferredLanguage(params: {
  supabase: SupabaseClient;
  customerId: string;
  messageText: string;
  detectedLanguage: string | null | undefined;
}): Promise<SupportedLang> {
  const { data: row } = await params.supabase
    .from("customers")
    .select("preferred_language")
    .eq("id", params.customerId)
    .maybeSingle();

  const current = (row?.preferred_language as string | null) ?? null;
  const detected = normaliseLanguageCode(params.detectedLanguage);

  if (
    detected &&
    isSubstantiveMessage(params.messageText) &&
    detected !== current
  ) {
    await params.supabase
      .from("customers")
      .update({ preferred_language: detected })
      .eq("id", params.customerId);
    return resolveLang(detected);
  }

  return resolveLang(current ?? detected);
}

/** Language instruction appended to AI system prompts for buyer-facing replies. */
export function buyerLanguageInstruction(
  preferredLang: string | null | undefined,
): string {
  const code = normaliseLanguageCode(preferredLang);
  if (code) {
    return `Reply in the same language as the buyer (preferred language code: ${code}). If you cannot write that language well, reply in English. Never translate product names, prices, order references, URLs, carrier names, or tracking numbers.`;
  }
  return `Reply in the same language as the buyer. If you cannot write that language well, reply in English. Never translate product names, prices, order references, URLs, carrier names, or tracking numbers.`;
}
