import { createHash } from "node:crypto";

import type {
  StubHandlerResult,
  VerifiedWebhookContext,
  WebhookSource,
} from "@/lib/webhooks/types";
import { parseFormBody } from "@/lib/webhooks/verify/signatures";

function hashBody(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
}

export function deriveIdempotencyKey(
  source: WebhookSource,
  headers: Headers,
  rawBody: string,
): string {
  const explicit =
    headers.get("idempotency-key") ?? headers.get("x-idempotency-key");
  if (explicit) return explicit;

  if (source === "twilio-whatsapp" || source === "twilio-sms") {
    const params = parseFormBody(rawBody);
    return params.MessageSid ?? params.SmsSid ?? hashBody(rawBody);
  }

  try {
    const json = JSON.parse(rawBody) as Record<string, unknown>;
    const candidate =
      json.event_id ??
      json.id ??
      (json.data as Record<string, unknown> | undefined)?.id;
    if (typeof candidate === "string") return candidate;
  } catch {
    /* fall through */
  }

  return hashBody(rawBody);
}

export function handleVerifiedWebhook(
  context: VerifiedWebhookContext,
): StubHandlerResult {
  console.info("[webhook-stub]", {
    source: context.source,
    verificationMode: context.verificationMode,
    stubReason: context.stubReason ?? null,
    idempotencyKey: context.idempotencyKey,
    duplicate: context.isDuplicate,
    contentType: context.contentType,
    payloadPreview:
      context.rawBody.length > 200
        ? `${context.rawBody.slice(0, 200)}…`
        : context.rawBody,
  });

  return {
    status: 200,
    body: {
      ok: true,
      source: context.source,
      verification: context.verificationMode,
      stubReason: context.stubReason ?? null,
      idempotencyKey: context.idempotencyKey,
      duplicate: context.isDuplicate,
      message: "Webhook received (stub handler)",
    },
  };
}
