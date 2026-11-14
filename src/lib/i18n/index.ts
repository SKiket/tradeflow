import { MESSAGES } from "@/lib/i18n/messages";
import type { MessageId, MessageVars, SupportedLang } from "@/lib/i18n/types";

export type { MessageId, MessageVars, SupportedLang } from "@/lib/i18n/types";
export { MESSAGES } from "@/lib/i18n/messages";

const SUPPORTED = new Set<string>(["en", "fr"]);

/** Resolve a language code to a supported fixed-message language (else en). */
export function resolveLang(lang: string | null | undefined): SupportedLang {
  if (!lang) return "en";
  const code = lang.trim().toLowerCase().slice(0, 2);
  if (SUPPORTED.has(code)) return code as SupportedLang;
  return "en";
}

/**
 * Translate a fixed buyer message. Falls back to English for unsupported
 * languages and never throws — missing keys/vars degrade gracefully.
 */
export function t(
  key: MessageId,
  lang: string | null | undefined,
  vars?: MessageVars,
): string {
  const resolved = resolveLang(lang);
  const table = MESSAGES[key];
  let template =
    table?.[resolved] ?? table?.en ?? `[missing message: ${key}]`;

  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      template = template.split(`{${name}}`).join(String(value));
    }
  }

  return template;
}
