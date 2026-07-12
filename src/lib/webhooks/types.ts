export const WEBHOOK_SOURCES = [
  "twilio-whatsapp",
  "twilio-sms",
  "stripe",
  "shippo",
] as const;

export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

export function isWebhookSource(value: string | null): value is WebhookSource {
  return WEBHOOK_SOURCES.includes(value as WebhookSource);
}

export interface VerifiedWebhookContext {
  source: WebhookSource;
  rawBody: string;
  contentType: string;
  headers: Headers;
  url: string;
  idempotencyKey: string;
  isDuplicate: boolean;
  payload: Record<string, string>;
  verificationMode: "real" | "stub";
  stubReason?: string;
}

export interface StubHandlerResult {
  status: number;
  body: Record<string, unknown>;
}
