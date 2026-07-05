import { anthropicProvider } from "@/lib/ai/providers/anthropic";
import { geminiProvider } from "@/lib/ai/providers/gemini";
import { openaiProvider } from "@/lib/ai/providers/openai";
import type { AIProvider } from "@/lib/ai/types";

const providers: Record<string, AIProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
};

export function getProvider(name: string): AIProvider {
  const provider = providers[name.toLowerCase()];
  if (!provider) {
    throw new Error(`Unknown AI provider: ${name}`);
  }
  return provider;
}

export { anthropicProvider, geminiProvider, openaiProvider };
