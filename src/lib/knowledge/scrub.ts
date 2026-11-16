import { GAP_QUESTION_MAX } from "@/lib/knowledge/types";

/** Phone patterns aligned with Sentry scrub (no /g lastIndex bugs on test). */
const PHONE_RE =
  /(?:\+|00)?(?:\d[\s().-]?){8,15}\d|\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
/** Long digit runs (cards, account numbers) — keep short codes. */
const LONG_NUMBER_RE = /\b\d{8,}\b/g;

/**
 * Scrub buyer question text for knowledge-gap storage.
 * Removes phones, emails, URLs, long numbers. Truncates to 300 chars.
 * Never stores customer identity — callers must not pass ids.
 */
export function scrubKnowledgeGapQuestion(raw: string): string {
  let text = String(raw ?? "")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(URL_RE, "[redacted-url]")
    .replace(PHONE_RE, "[redacted-phone]")
    .replace(LONG_NUMBER_RE, "[redacted-number]")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > GAP_QUESTION_MAX) {
    text = `${text.slice(0, GAP_QUESTION_MAX - 1)}…`;
  }
  return text;
}

/** Normalise for hashing: lower-case, collapse whitespace. */
export function normaliseQuestionForHash(scrubbed: string): string {
  return scrubbed.toLowerCase().replace(/\s+/g, " ").trim();
}
