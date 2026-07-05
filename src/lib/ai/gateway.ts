import { getProvider } from "@/lib/ai/providers";
import { createAdminClient } from "@/lib/supabase/admin";

import type {
  AIModelConfig,
  GatewayRunParams,
  GatewayRunResult,
  GenerateStructuredParams,
} from "./types";
import { GATEWAY_TIMEOUT_MS } from "./types";

async function loadConfig(taskKey: string): Promise<AIModelConfig> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_model_config")
    .select(
      "task_key, provider, model, fallback_provider, fallback_model, max_tokens, is_active",
    )
    .eq("task_key", taskKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load ai_model_config for "${taskKey}": ${error.message}`);
  }
  if (!data) {
    throw new Error(`No ai_model_config row found for taskKey "${taskKey}"`);
  }
  if (!data.is_active) {
    throw new Error(`AI task "${taskKey}" is disabled (is_active = false)`);
  }

  return data;
}

async function callProvider(
  providerName: string,
  model: string,
  params: Omit<GatewayRunParams, "taskKey"> & { maxTokens?: number | null },
): Promise<GatewayRunResult> {
  const provider = getProvider(providerName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

  try {
    const generateParams: GenerateStructuredParams = {
      model,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      schema: params.schema,
      maxTokens: params.maxTokens ?? undefined,
      signal: controller.signal,
    };

    const result = await provider.generateStructured(generateParams);

    return {
      ...result,
      provider: providerName,
      model,
      usedFallback: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function run(params: GatewayRunParams): Promise<GatewayRunResult> {
  const config = await loadConfig(params.taskKey);

  const attemptParams = {
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
    schema: params.schema,
    maxTokens: config.max_tokens,
  };

  try {
    const primary = await callProvider(
      config.provider,
      config.model,
      attemptParams,
    );
    return primary;
  } catch (primaryError) {
    if (!config.fallback_provider || !config.fallback_model) {
      throw primaryError;
    }

    try {
      const fallback = await callProvider(
        config.fallback_provider,
        config.fallback_model,
        attemptParams,
      );
      return { ...fallback, usedFallback: true };
    } catch (fallbackError) {
      const primaryMsg =
        primaryError instanceof Error ? primaryError.message : String(primaryError);
      const fallbackMsg =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `Primary provider failed (${primaryMsg}); fallback also failed (${fallbackMsg})`,
      );
    }
  }
}
