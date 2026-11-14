import type { JSONSchema7 } from "json-schema";

import { run } from "@/lib/ai/gateway";

/**
 * Structured output for taskKey "audio_transcribe".
 */
export interface AudioTranscribeResult {
  transcript: string;
  language: string;
  confidence: "high" | "medium" | "low";
}

export const AUDIO_TRANSCRIBE_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    transcript: {
      type: "string",
      description:
        "Exact words spoken in the original language. Empty string when inaudible or no speech.",
    },
    language: {
      type: "string",
      description: 'BCP-47 / short language code when detectable, else ""',
    },
    confidence: {
      type: "string",
      description: 'One of: "high", "medium", "low"',
    },
  },
  required: ["transcript", "language", "confidence"],
  additionalProperties: false,
};

export const AUDIO_TRANSCRIBE_SYSTEM_PROMPT = `You are a speech transcription engine for shop order voice notes.

Rules:
- Transcribe exactly what was said, in the original language.
- Never add words, never translate, never summarise, never guess missing words.
- If the audio is inaudible, silent, noise-only, or contains no speech, return an empty transcript and confidence "low".
- confidence must be exactly one of: "high", "medium", "low".
- language should be a short code (e.g. en, fr) when clear, otherwise "".`;

const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

/**
 * Transcribe an in-memory audio clip via the AI gateway (Gemini multimodal).
 * Does not persist the audio anywhere.
 */
export async function transcribeAudio(params: {
  audio: Buffer;
  mimeType: string;
}): Promise<AudioTranscribeResult> {
  const result = await run({
    taskKey: "audio_transcribe",
    systemPrompt: AUDIO_TRANSCRIBE_SYSTEM_PROMPT,
    userPrompt:
      "Transcribe this voice note exactly. Return JSON matching the schema.",
    schema: AUDIO_TRANSCRIBE_SCHEMA,
    media: {
      mimeType: params.mimeType,
      data: params.audio,
    },
  });

  return normaliseTranscribeResult(result.data);
}

function normaliseTranscribeResult(data: unknown): AudioTranscribeResult {
  const row = (data ?? {}) as Record<string, unknown>;
  const transcript =
    typeof row.transcript === "string" ? row.transcript.trim() : "";
  const language = typeof row.language === "string" ? row.language.trim() : "";
  const rawConfidence =
    typeof row.confidence === "string" ? row.confidence.trim().toLowerCase() : "";
  const confidence = CONFIDENCE_VALUES.has(rawConfidence)
    ? (rawConfidence as AudioTranscribeResult["confidence"])
    : "low";

  return { transcript, language, confidence };
}
