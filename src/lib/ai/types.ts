import type { JSONSchema7 } from "json-schema";

export interface GenerateStructuredParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema: JSONSchema7;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateStructuredResult {
  data: unknown;
  raw: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AIProvider {
  readonly name: string;
  generateStructured(
    params: GenerateStructuredParams,
  ): Promise<GenerateStructuredResult>;
}

export interface AIModelConfig {
  task_key: string;
  provider: string;
  model: string;
  fallback_provider: string | null;
  fallback_model: string | null;
  max_tokens: number | null;
  is_active: boolean;
}

export interface GatewayRunParams {
  taskKey: string;
  systemPrompt: string;
  userPrompt: string;
  schema: JSONSchema7;
}

export interface GatewayRunResult extends GenerateStructuredResult {
  provider: string;
  model: string;
  usedFallback: boolean;
}

export const GATEWAY_TIMEOUT_MS = 20_000;
