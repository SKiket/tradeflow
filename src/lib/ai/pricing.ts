/**
 * Per-million-token USD rates. Review periodically — Spec Section 5.4.
 * Source: provider pricing pages as of mid-2025.
 */
export const MODEL_PRICING_USD_PER_MILLION: Record<
  string,
  { input: number; output: number }
> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-3-5-sonnet-latest": { input: 3.0, output: 15.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
};

const DEFAULT_RATES = { input: 1.0, output: 5.0 };

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = MODEL_PRICING_USD_PER_MILLION[model] ?? DEFAULT_RATES;
  return (
    (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000
  );
}
