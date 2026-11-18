/**
 * Scrub PII from seller text / conversation context before AI assist calls.
 * Keeps first names already in conversation; strips phones, emails, streets.
 */

const PHONE_RE =
  /(?:\+|00)?(?:\d[\s().-]?){8,15}\d|\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const ADDRESS_LIKE_RE =
  /\b\d{1,4}\s+[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,4}\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Close|Cl|Way|Court|Ct|Boulevard|Blvd|Place|Pl)\b/gi;

export function scrubAssistText(raw: string): string {
  return String(raw ?? "")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]")
    .replace(ADDRESS_LIKE_RE, "[redacted-address]")
    .replace(/\s+/g, " ")
    .trim();
}

export function scrubAssistObject<T extends Record<string, unknown>>(
  value: T,
): T {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      out[key] = scrubAssistText(child);
    } else if (Array.isArray(child)) {
      out[key] = child.map((item) =>
        typeof item === "string"
          ? scrubAssistText(item)
          : item && typeof item === "object"
            ? scrubAssistObject(item as Record<string, unknown>)
            : item,
      );
    } else if (child && typeof child === "object") {
      out[key] = scrubAssistObject(child as Record<string, unknown>);
    } else {
      out[key] = child;
    }
  }
  return out as T;
}

/** True when scrubbed text still contains raw phone/email/address patterns. */
export function scrubMissedPii(text: string): boolean {
  return (
    EMAIL_RE.test(text) ||
    PHONE_RE.test(text) ||
    ADDRESS_LIKE_RE.test(text)
  );
}
