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

function normalizeForLang(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s.,!?¡¿]+|[\s.,!?¡¿]+$/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Exact short acks / numbers / emoji that must NOT flip conversation language.
 * Longer messages that happen to start with "non"/"no" are NOT ambiguous.
 */
export function isAmbiguousLanguageMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  if (isAffirmativeReply(trimmed)) return true;

  const normalized = normalizeForLang(trimmed);
  if (!normalized) return true;

  // Exact short negatives only (not "Non, 1 tasse plutôt")
  const exactNegatives = new Set([
    "no",
    "nope",
    "nah",
    "non",
    "cancel",
    "cancelled",
    "canceled",
    "annuler",
    "annule",
    "annulé",
    "annulee",
    "annulée",
    "no thanks",
    "no thank you",
    "non merci",
  ]);
  if (exactNegatives.has(normalized)) return true;

  // Pure number
  if (/^\d+([.,]\d+)?$/.test(normalized)) return true;

  // Emoji / punctuation only
  const withoutEmoji = trimmed.replace(
    /[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\p{P}]/gu,
    "",
  );
  if (!withoutEmoji) return true;

  return false;
}

/**
 * Drop Title-Case product-like spans so a French product name inside an
 * English sentence does not flip the conversation language.
 * e.g. "I want 2 Croissant Box" → "I want 2"
 */
export function stripLikelyProductSpans(text: string): string {
  return text.replace(
    /\b(?:[A-ZÀ-Ü][\w'’.-]*(?:\s+[A-ZÀ-Ü][\w'’.-]*)+)\b/g,
    " ",
  );
}

/**
 * Lightweight lexical hint when AI has not yet returned a language code.
 * Scores sentence function words after stripping product-like Title Case
 * spans, so catalogue names in another language do not cause false switches.
 */
export function heuristicLanguage(text: string): string | null {
  if (isAmbiguousLanguageMessage(text)) return null;

  const stripped = stripLikelyProductSpans(text);
  const lower = stripped.toLowerCase();

  const frHits = (
    lower.match(
      /\b(je|j'|tu|vous|nous|mon|ma|mes|ton|ta|tes|le|la|les|un|une|des|du|au|aux|voudrais|veut|bonjour|merci|plutôt|plutot|commande|avec|sans|pour|s'il|svp|plait|plaît|tasse|tasses|bleue|bleues|deux|trois|quatre)\b/g,
    ) ?? []
  ).length;
  const frAccent = /[àâäéèêëïîôùûüçœ]/i.test(stripped) ? 1 : 0;

  const esHits = (
    lower.match(
      /\b(hola|quiero|gracias|por\s+favor|taza|tazas|dos|una|unos|pedido)\b/g,
    ) ?? []
  ).length;
  const esAccent = /[áéíóúñ¿¡]/i.test(stripped) ? 1 : 0;

  const enHits = (
    lower.match(
      /\b(i|i'd|i'm|want|please|mug|mugs|order|thanks|thank you|hello|hi|with|without|blue|two|three|four|make|instead)\b/g,
    ) ?? []
  ).length;

  const frScore = frHits + frAccent;
  const esScore = esHits + esAccent;
  const enScore = enHits;

  // Prefer the matrix language of the sentence (function words), not product nouns.
  if (enScore > 0 && enScore >= frScore && enScore >= esScore) {
    return "en";
  }
  if (frScore > 0 && frScore >= esScore) {
    return "fr";
  }
  if (esScore > 0) {
    return "es";
  }
  if (enScore > 0) {
    return "en";
  }

  return null;
}

/**
 * Legacy helper kept for D1: "substantive" ≈ 3+ words and not a short ack.
 * Conversation-language updates use {@link carriesClearLanguageSignal} instead.
 */
export function isSubstantiveMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isAffirmativeReply(trimmed) || isNegativeReply(trimmed)) return false;

  const normalized = normalizeForLang(trimmed);
  const words = normalized.split(" ").filter(Boolean);
  return words.length >= 3;
}

/**
 * True when this inbound clearly carries a language we should store.
 * Short ambiguous messages (yes/no, numbers, emoji) inherit conversation lang.
 * Two-word clear French ("Deux tasses") counts when detection/heuristic agrees.
 */
export function carriesClearLanguageSignal(params: {
  text: string;
  detectedLanguage?: string | null | undefined;
}): boolean {
  if (isAmbiguousLanguageMessage(params.text)) return false;
  const detected =
    normaliseLanguageCode(params.detectedLanguage) ??
    heuristicLanguage(params.text);
  return Boolean(detected);
}

/** @deprecated Prefer carriesClearLanguageSignal — kept for callers/tests. */
export function isConfidentLanguageSignal(params: {
  text: string;
  detectedLanguage: string | null | undefined;
  confidence?: number | null;
}): boolean {
  if (!carriesClearLanguageSignal(params)) return false;
  if (isSubstantiveMessage(params.text)) return true;
  if (typeof params.confidence === "number" && params.confidence >= 0.8) {
    return true;
  }
  return Boolean(
    normaliseLanguageCode(params.detectedLanguage) ??
      heuristicLanguage(params.text),
  );
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
 * Persist preferred_language when the inbound carries a clear language signal.
 * Returns the language to use for the next reply (conversation language).
 *
 * Rule: clear signal → store and use it; ambiguous → inherit stored (or
 * detected if nothing stored yet). Never reset to English on a short ack.
 */
export async function maybeUpdatePreferredLanguage(params: {
  supabase: SupabaseClient;
  customerId: string;
  messageText: string;
  detectedLanguage: string | null | undefined;
  /** Optional AI confidence 0–1 (unused for clear-signal gate; kept for API). */
  confidence?: number | null;
}): Promise<SupportedLang> {
  const { data: row } = await params.supabase
    .from("customers")
    .select("preferred_language")
    .eq("id", params.customerId)
    .maybeSingle();

  const current = (row?.preferred_language as string | null) ?? null;
  const detected =
    normaliseLanguageCode(params.detectedLanguage) ??
    heuristicLanguage(params.messageText);

  const clear = carriesClearLanguageSignal({
    text: params.messageText,
    detectedLanguage: detected,
  });

  if (clear && detected && detected !== current) {
    await params.supabase
      .from("customers")
      .update({ preferred_language: detected })
      .eq("id", params.customerId);
    return resolveLang(detected);
  }

  if (!clear) {
    return resolveLang(current ?? detected);
  }

  if (clear && detected && current == null) {
    await params.supabase
      .from("customers")
      .update({ preferred_language: detected })
      .eq("id", params.customerId);
  }

  return resolveLang(detected ?? current);
}

/**
 * Language instruction for AI buyer-facing replies.
 * Latest message wins; preferred is memory for ambiguous follow-ups only.
 */
export function buyerLanguageInstruction(
  preferredLang: string | null | undefined,
): string {
  const code = normaliseLanguageCode(preferredLang);
  const memory = code
    ? `Conversation language memory (ISO 639-1): ${code}. Use this ONLY when the latest message is ambiguous (yes/no, a bare number, emoji).`
    : `No conversation language is stored yet — detect from the latest message.`;
  return [
    "Reply in the same language as the buyer's LATEST message.",
    "Never silently fall back to English when the buyer wrote in another language.",
    memory,
    "If the latest message clearly switches language, follow that switch.",
    "Never translate product names, prices, order references, URLs, carrier names, or tracking numbers.",
  ].join(" ");
}
