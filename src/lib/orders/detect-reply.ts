/**
 * Deterministic affirmative/negative reply detection for draft confirmation.
 * No AI — fast path for obvious "yes"/"no" replies (English + French).
 *
 * Cancel vs correction for negative openers is content-based (not word count):
 * order content (quantity / number / catalogue product|variant) → correction;
 * explicit cancel intent or no order content → cancel.
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

/** Explicit cancel intent anywhere after a negative opener (any length). */
const EXPLICIT_CANCEL_PATTERNS: RegExp[] = [
  /\bannul(er|e|é|ee|ée|és|ées)?\b/i,
  /\bcancel(l?ed|ling)?\b/i,
  /\bplus besoin\b/i,
  /\bne veux plus\b/i,
  /\bne veut plus\b/i,
  /\bje ne veux plus\b/i,
  /\bdon't want\b/i,
  /\bdo not want\b/i,
  /\bdont want\b/i,
  /\bno longer want\b/i,
  /\bdon't need\b/i,
  /\bdo not need\b/i,
  /\bnot anymore\b/i,
  /\bit anymore\b/i,
  /\blaisse(r)? tomber\b/i,
  /\banule tout\b/i,
  /\bcancel (it|all|everything|tout)\b/i,
  /\bannule tout\b/i,
];

/** Quantity / count words that count as order content (EN + FR). */
const QUANTITY_WORD_RE =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|make it)\b/i;

export type NegativeOpenerKind = "cancel" | "correction" | null;

export interface NegativeOpenerOptions {
  /** Catalogue product / variant name tokens (any language). */
  productTerms?: string[] | null;
}

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

/**
 * Strip a leading no/non opener; return null if the message is not a
 * negative-opener form.
 */
export function stripNegativeOpener(text: string): string | null {
  const normalized = normalizeReply(text);
  if (!normalized) return null;

  if (NEGATIVE_PHRASES.has(normalized)) {
    return "";
  }

  const opener =
    /^(?:nope|nah|no thanks|no thank you|non merci|no|non)(?:\s*[,.]?\s+|\s*[,.]\s*|\s+)/i;
  if (!opener.test(normalized)) {
    // Also allow "no," / "non," glued without space after normalize
    if (/^(?:no|non)[,.]/.test(normalized)) {
      return normalized.replace(/^(?:no|non)[,.]+\s*/, "").trim();
    }
    return null;
  }
  return normalized.replace(opener, "").trim();
}

export function hasExplicitCancelIntent(text: string): boolean {
  const normalized = normalizeReply(text);
  if (!normalized) return false;
  if (NEGATIVE_PHRASES.has(normalized)) return true;
  return EXPLICIT_CANCEL_PATTERNS.some((re) => re.test(normalized));
}

/**
 * True when the remainder carries order content: a digit/quantity, or a
 * catalogue product/variant term (case-insensitive substring / token match).
 */
export function hasOrderContent(
  text: string,
  options?: NegativeOpenerOptions,
): boolean {
  const normalized = normalizeReply(text);
  if (!normalized) return false;

  if (/\d/.test(normalized)) return true;
  if (QUANTITY_WORD_RE.test(normalized)) return true;

  const terms = options?.productTerms ?? [];
  for (const raw of terms) {
    const term = normalizeReply(raw);
    if (term.length < 2) continue;
    if (normalized.includes(term)) return true;
    // Token overlap: any catalogue token ≥3 chars present in the message
    for (const token of term.split(" ").filter((t) => t.length >= 3)) {
      if (new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(normalized)) {
        return true;
      }
    }
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Classify a message that may start with a negative opener.
 * - cancel: exact negative, explicit cancel intent, or negative opener without order content
 * - correction: negative opener + order content (qty / number / catalogue term)
 * - null: not a negative-opener message
 */
export function classifyNegativeOpener(
  text: string,
  options?: NegativeOpenerOptions,
): NegativeOpenerKind {
  const normalized = normalizeReply(text);
  if (!normalized) return null;

  if (NEGATIVE_PHRASES.has(normalized)) {
    return "cancel";
  }

  // Standalone cancel verbs without no/non
  if (
    /^(annuler|annule|annulé|annulee|annulée|cancel|cancelled|canceled)$/i.test(
      normalized,
    )
  ) {
    return "cancel";
  }

  const rest = stripNegativeOpener(text);
  if (rest === null) return null;

  // Bare "no" / "non" (rest empty)
  if (rest === "") return "cancel";

  if (hasExplicitCancelIntent(rest) || hasExplicitCancelIntent(normalized)) {
    // "Non merci, annule tout" — cancel intent wins even if a number appeared
    return "cancel";
  }

  if (hasOrderContent(rest, options)) {
    return "correction";
  }

  // Ambiguous remainder ("peut-être plus tard", "pas du tout, merci beaucoup")
  return "cancel";
}

/**
 * True for cancel replies (deterministic). Corrections with a negative opener
 * + order content return false so the message falls through to order_parse.
 */
export function isNegativeReply(
  text: string,
  options?: NegativeOpenerOptions,
): boolean {
  return classifyNegativeOpener(text, options) === "cancel";
}

/**
 * Build searchable product/variant terms from an active catalogue.
 */
export function productTermsFromCatalog(
  catalog: Array<{
    name?: string | null;
    variants?: Array<{ label?: string | null } | null> | null;
  }>,
): string[] {
  const terms: string[] = [];
  for (const product of catalog) {
    if (product.name?.trim()) terms.push(product.name.trim());
    for (const variant of product.variants ?? []) {
      if (variant?.label?.trim()) terms.push(variant.label.trim());
    }
  }
  return terms;
}
