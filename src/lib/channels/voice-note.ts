/**
 * Voice-note transparency helpers. Transcripts are stored on
 * messages.normalised_text with source_kind = "voice_note".
 */

import { t } from "@/lib/i18n";

export const SOURCE_KIND_VOICE_NOTE = "voice_note";

/** Prefix buyer-facing automated replies when the inbound was a voice note. */
export function voiceHeardPrefix(
  transcript: string,
  lang?: string | null,
): string {
  return t("voice.heard_prefix", lang, { transcript: transcript.trim() });
}

export function withReplyPrefix(
  prefix: string | null | undefined,
  text: string,
): string {
  if (!prefix) return text;
  return `${prefix}${text}`;
}
