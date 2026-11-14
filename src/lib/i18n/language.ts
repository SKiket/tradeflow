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
  const match = trimmed.match(/^[a-z]{2}/);
  return match ? match[0] : null;
}

/**
 * Exact language rule (D1):
 * - Reply language comes from the latest *substantive* message.
 * - Substantive ≈ 3+ words (after trim), or a confident language detection
 *   on a message that is not a short ack.
 * - Very short messages ("ok", "3 mugs", YES/NO) keep the stored preference
 *   and must not flip preferred_language.
 */
export function isSubstantiveMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isAffirmativeReply(trimmed) || isNegativeReply(trimmed)) return false;

  const normalized = trimmed
    .toLowerCase()
    .replace(/^[\s.,!?]+|[\s.,!?]+$/g, "")
    .replace(/\s+/g, " ");

  const words = normalized.split(" ").filter(Boolean);
  // Short messages keep stored preference: "ok", "3 mugs", etc.
  if (words.length < 3) return false;

  return true;
}

/**
 * True when the model reported a usable language with enough confidence
 * that we may treat a shorter-than-3-word message as a language signal.
 * (Reserved for AI paths that pass confidence; word-count rule still
 * applies for fixed short acks.)
 */
export function isConfidentLanguageSignal(params: {
  text: string;
  detectedLanguage: string | null | undefined;
  confidence?: number | null;
}): boolean {
  if (!normaliseLanguageCode(params.detectedLanguage)) return false;
  if (isAffirmativeReply(params.text) || isNegativeReply(params.text)) {
    return false;
  }
  const words = params.text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 3) return true;
  // Confident detection alone is enough only when not a tiny ack and
  // confidence is high (e.g. clear French voice note of 2 words).
  if (typeof params.confidence === "number" && params.confidence >= 0.8) {
    return words.length >= 2;
  }
  return false;
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
 * Persist preferred_language only for substantive messages (or confident
 * signals). Returns the language that should be used for the next reply:
 * detected language when the message is substantive, otherwise stored.
 */
export async function maybeUpdatePreferredLanguage(params: {
  supabase: SupabaseClient;
  customerId: string;
  messageText: string;
  detectedLanguage: string | null | undefined;
  /** Optional AI confidence 0–1 for shorter-but-confident signals. */
  confidence?: number | null;
}): Promise<SupportedLang> {
  const { data: row } = await params.supabase
    .from("customers")
    .select("preferred_language")
    .eq("id", params.customerId)
    .maybeSingle();

  const current = (row?.preferred_language as string | null) ?? null;
  const detected = normaliseLanguageCode(params.detectedLanguage);

  const substantive = isSubstantiveMessage(params.messageText);
  const confident = isConfidentLanguageSignal({
    text: params.messageText,
    detectedLanguage: params.detectedLanguage,
    confidence: params.confidence,
  });

  if (detected && (substantive || confident) && detected !== current) {
    await params.supabase
      .from("customers")
      .update({ preferred_language: detected })
      .eq("id", params.customerId);
    return resolveLang(detected);
  }

  // Short messages ("ok", "3 mugs"): keep stored preference for the reply.
  if (!substantive && !confident) {
    return resolveLang(current ?? detected);
  }

  return resolveLang(detected ?? current);
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
