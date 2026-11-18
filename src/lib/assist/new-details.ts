/**
 * Warn (do not block) when a suggestion introduces amounts, dates, times,
 * "days", discounts, or refund wording absent from seller text + context.
 */

export type NewDetailHit = {
  /** Matched snippet from the suggestion. */
  text: string;
  kind: "amount" | "percent" | "date" | "time" | "days" | "discount" | "refund";
};

const PATTERNS: Array<{ kind: NewDetailHit["kind"]; re: RegExp }> = [
  { kind: "amount", re: /£\s?\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s*(?:gbp|pounds?)\b/gi },
  { kind: "percent", re: /\b\d{1,3}\s?%/g },
  {
    kind: "date",
    re: /\b(?:\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4}|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche))\b/gi,
  },
  { kind: "time", re: /\b(?:[01]?\d|2[0-3])[:h]\d{2}(?:\s?[ap]m)?\b|\b\d{1,2}\s?[ap]m\b/gi },
  { kind: "days", re: /\b\d+\s*(?:day|days|jour|jours)\b/gi },
  {
    kind: "discount",
    re: /\b(?:discount|promo(?:tion)?|offre|réduction|reduction|%\s*off)\b/gi,
  },
  {
    kind: "refund",
    re: /\b(?:refund|remboursement|reimburse|money\s+back)\b/gi,
  },
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function findNewDetails(
  suggestion: string,
  allowedSource: string,
): NewDetailHit[] {
  const source = normalize(allowedSource);
  const hits: NewDetailHit[] = [];
  for (const { kind, re } of PATTERNS) {
    const local = new RegExp(re.source, re.flags);
    let match: RegExpExecArray | null;
    while ((match = local.exec(suggestion)) !== null) {
      const snippet = match[0];
      if (!source.includes(normalize(snippet))) {
        hits.push({ text: snippet, kind });
      }
    }
  }
  return hits;
}
