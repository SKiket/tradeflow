import type { JSONSchema7 } from "json-schema";

import { run } from "@/lib/ai/gateway";

export type ReplyClassification = "affirmative" | "negative" | "other";

export interface ReplyClassifyResult {
  classification: ReplyClassification;
}

export const REPLY_CLASSIFY_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    classification: {
      type: "string",
      description: 'One of: "affirmative", "negative", "other"',
    },
  },
  required: ["classification"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You classify a buyer's WhatsApp reply in the context of having been asked to confirm a draft order, or after they were sent a payment link that has not been paid yet.

Return exactly one classification:
- "affirmative" — they want to proceed / confirm / pay (e.g. "yeah sounds good", "go ahead", "let's do it")
- "negative" — they want to cancel or decline (e.g. "no thanks", "cancel that", "actually cancel that", "never mind")
- "other" — anything else (questions, corrections, item changes, unrelated)

Respond with JSON matching the schema exactly.`;

/**
 * Lightweight AI fallback when deterministic reply matching misses.
 * Called when the thread has an open PENDING_CONFIRMATION or AWAITING_PAYMENT order.
 */
export async function classifyReply(
  messageText: string,
): Promise<ReplyClassifyResult> {
  const result = await run({
    taskKey: "reply_classify",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Buyer message:\n${messageText.trim()}`,
    schema: REPLY_CLASSIFY_SCHEMA,
  });

  const record = (result.data ?? {}) as Record<string, unknown>;
  const raw =
    typeof record.classification === "string"
      ? record.classification.toLowerCase()
      : "other";

  const classification: ReplyClassification =
    raw === "affirmative" || raw === "negative" ? raw : "other";

  return { classification };
}
