import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";
import type { JSONSchema7 } from "json-schema";

import { computeCostUsd } from "@/lib/ai/pricing";
import type { AIProvider, GenerateStructuredParams } from "@/lib/ai/types";
import { assertMatchesSchema } from "@/lib/ai/validate-schema";

function getApiKey() {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not configured");
  }
  return apiKey;
}

function toGeminiSchema(schema: JSONSchema7): ResponseSchema {
  if (schema.type !== "object" || !schema.properties) {
    throw new Error("Gemini adapter supports object schemas only");
  }

  const properties: Record<string, ResponseSchema> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (typeof prop === "boolean") continue;
    properties[key] = jsonSchemaPropertyToGemini(prop);
  }

  return {
    type: SchemaType.OBJECT,
    properties,
    required: schema.required ?? [],
  };
}

function jsonSchemaPropertyToGemini(schema: JSONSchema7): ResponseSchema {
  switch (schema.type) {
    case "string":
      return { type: SchemaType.STRING };
    case "number":
    case "integer":
      return { type: SchemaType.NUMBER };
    case "boolean":
      return { type: SchemaType.BOOLEAN };
    case "array":
      return {
        type: SchemaType.ARRAY,
        items: schema.items
          ? jsonSchemaPropertyToGemini(schema.items as JSONSchema7)
          : { type: SchemaType.STRING },
      };
    case "object":
      return toGeminiSchema(schema);
    default:
      return { type: SchemaType.STRING };
  }
}

export const geminiProvider: AIProvider = {
  name: "gemini",

  async generateStructured(params: GenerateStructuredParams) {
    const genAI = new GoogleGenerativeAI(getApiKey());
    const model = genAI.getGenerativeModel({
      model: params.model,
      systemInstruction: params.systemPrompt,
      generationConfig: {
        maxOutputTokens: params.maxTokens ?? 1024,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(params.schema),
      },
    });

    const abortPromise = params.signal
      ? new Promise<never>((_, reject) => {
          params.signal!.addEventListener("abort", () => {
            reject(new Error("Gemini request timed out"));
          });
        })
      : null;

    const result = await (abortPromise
      ? Promise.race([model.generateContent(params.userPrompt), abortPromise])
      : model.generateContent(params.userPrompt));

    const text = result.response.text();
    const data = JSON.parse(text) as unknown;
    assertMatchesSchema(data, params.schema);

    const usage = result.response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

    return {
      data,
      raw: result.response,
      inputTokens,
      outputTokens,
      costUsd: computeCostUsd(params.model, inputTokens, outputTokens),
    };
  },
};
