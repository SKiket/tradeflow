/**
 * Deterministic affirmative/negative reply detection for draft confirmation.
 * No AI — fast path for obvious "yes"/"no" replies (English + French).
 */

const AFFIRMATIVE_PHRASES = new Set([
  "yes",
  "yes please",
  "confirm",
  "confirmed",
  "yep",
  "yeah",
  "ok",
  "okay",
  "👍",
  "✅",
  // French
  "oui",
  "ouais",
  "d'accord",
  "daccord",
  "dac",
  "volontiers",
]);

const NEGATIVE_PHRASES = new Set([
  "no",
  "no thanks",
  "no thank you",
  "no, cancel",
  "no cancel",
  "cancel",
  "cancelled",
  "canceled",
  "nope",
  "nah",
  // French
  "non",
  "annuler",
  "annule",
  "annulé",
  "annulee",
  "annulée",
  "laisse tomber",
  "laisser tomber",
  "non merci",
]);

/** Strip trivial punctuation/whitespace for matching. */
function normalizeReply(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s.,!?]+|[\s.,!?]+$/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Returns true when the message is an obvious affirmative confirmation.
 * Does not handle nuanced phrases like "yeah sounds good" — use AI fallback.
 */
export function isAffirmativeReply(text: string): boolean {
  const normalized = normalizeReply(text);
  if (!normalized) return false;
  return AFFIRMATIVE_PHRASES.has(normalized);
}

/** Returns true for obvious negative/cancel replies (deterministic only). */
export function isNegativeReply(text: string): boolean {
  const normalized = normalizeReply(text);
  if (!normalized) return false;
  if (NEGATIVE_PHRASES.has(normalized)) return true;
  return (
    normalized.startsWith("no ") ||
    normalized.startsWith("no,") ||
    normalized.startsWith("non ") ||
    normalized.startsWith("non,")
  );
}
