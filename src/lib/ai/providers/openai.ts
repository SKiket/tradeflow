import OpenAI from "openai";

import { computeCostUsd } from "@/lib/ai/pricing";
import type { AIProvider, GenerateStructuredParams } from "@/lib/ai/types";
import { assertMatchesSchema } from "@/lib/ai/validate-schema";

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  return new OpenAI({ apiKey });
}

export const openaiProvider: AIProvider = {
  name: "openai",

  async generateStructured(params: GenerateStructuredParams) {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: params.model,
        max_tokens: params.maxTokens ?? 1024,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "structured_output",
            schema: params.schema as Record<string, unknown>,
            strict: true,
          },
        },
      },
      { signal: params.signal },
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI response did not include content");
    }

    const data = JSON.parse(content) as unknown;
    assertMatchesSchema(data, params.schema);

    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    return {
      data,
      raw: response,
      inputTokens,
      outputTokens,
      costUsd: computeCostUsd(params.model, inputTokens, outputTokens),
    };
  },
};
