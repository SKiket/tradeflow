export type WebhookVerificationMode = "real" | "stub";

export interface WebhookVerificationResult {
  valid: boolean;
  mode: WebhookVerificationMode;
  stubReason?: string;
}

export function isWebhookSecretConfigured(
  value: string | undefined,
): value is string {
  if (!value || value.trim().length === 0) return false;
  if (value.startsWith("test-")) return false;
  if (value.startsWith("your-")) return false;
  return true;
}
