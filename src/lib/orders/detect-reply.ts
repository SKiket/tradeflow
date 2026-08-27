/**
 * Deterministic affirmative-reply detection for draft confirmation.
 * No AI — fast path for obvious "yes" replies.
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
  const negatives = [
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
  ];
  return (
    negatives.includes(normalized) ||
    normalized.startsWith("no ") ||
    normalized.startsWith("no,")
  );
}
