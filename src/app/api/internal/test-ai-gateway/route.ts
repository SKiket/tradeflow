import type { JSONSchema7 } from "json-schema";
import { NextResponse } from "next/server";

import { run } from "@/lib/ai/gateway";

/**
 * Internal verification route — remove or auth-gate before Phase 1 ships.
 * Note: Next.js treats `_`-prefixed app folders as private (non-routable),
 * so this lives at /api/internal/test-ai-gateway instead of /api/_internal/...
 */
const PING_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    answer: { type: "string" },
  },
  required: ["answer"],
  additionalProperties: false,
};

export async function GET() {
  try {
    const result = await run({
      taskKey: "test_ping",
      systemPrompt:
        "You are a test assistant. Respond with JSON matching the schema exactly.",
      userPrompt: 'Reply with {"answer": "pong"}',
      schema: PING_SCHEMA,
    });

    return NextResponse.json({
      ok: true,
      data: result.data,
      provider: result.provider,
      model: result.model,
      usedFallback: result.usedFallback,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
