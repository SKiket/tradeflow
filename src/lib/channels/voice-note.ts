/**
 * Voice-note transparency helpers. Transcripts are stored on
 * messages.normalised_text with source_kind = "voice_note".
 */

export const SOURCE_KIND_VOICE_NOTE = "voice_note";

/** Prefix buyer-facing automated replies when the inbound was a voice note. */
export function voiceHeardPrefix(transcript: string): string {
  const trimmed = transcript.trim();
  return `I heard: "${trimmed}" — `;
}

export function withReplyPrefix(
  prefix: string | null | undefined,
  text: string,
): string {
  if (!prefix) return text;
  return `${prefix}${text}`;
}
