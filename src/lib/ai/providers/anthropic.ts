import Anthropic from "@anthropic-ai/sdk";

import { computeCostUsd } from "@/lib/ai/pricing";
import type { AIProvider, GenerateStructuredParams } from "@/lib/ai/types";
import { assertMatchesSchema } from "@/lib/ai/validate-schema";

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  return new Anthropic({ apiKey });
}

export const anthropicProvider: AIProvider = {
  name: "anthropic",

  async generateStructured(params: GenerateStructuredParams) {
    const client = getClient();
    const response = await client.messages.create(
      {
        model: params.model,
        max_tokens: params.maxTokens ?? 1024,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
        tools: [
          {
            name: "structured_output",
            description: "Return JSON matching the provided schema",
            input_schema: params.schema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: "structured_output" },
      },
      { signal: params.signal },
    );

    const toolBlock = response.content.find(
      (block) => block.type === "tool_use",
    );

    if (!toolBlock || toolBlock.type !== "tool_use") {
      throw new Error("Anthropic response did not include structured tool output");
    }

    const data = toolBlock.input;
    assertMatchesSchema(data, params.schema);

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    return {
      data,
      raw: response,
      inputTokens,
      outputTokens,
      costUsd: computeCostUsd(params.model, inputTokens, outputTokens),
    };
  },
};
