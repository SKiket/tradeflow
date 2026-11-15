import { NextResponse, type NextRequest } from "next/server";

import { handleShippoEvent } from "@/lib/webhooks/handlers/shippo";
import { deriveIdempotencyKey } from "@/lib/webhooks/handlers/stub";
import { checkIdempotency } from "@/lib/webhooks/idempotency";
import { isWebhookSecretConfigured } from "@/lib/webhooks/verify/config";
import { verifyShippoWebhookToken } from "@/lib/webhooks/verify/signatures";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function publicRequestUrl(request: NextRequest): string {
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto") ??
    url.protocol.replace(":", "") ??
    "https";
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

/**
 * Shippo track_updated webhook.
 * Auth: long random token in ?token= compared to SHIPPO_WEBHOOK_SECRET
 * (fail closed when unset). Never log the token.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.SHIPPO_WEBHOOK_SECRET;
  if (!isWebhookSecretConfigured(secret)) {
    console.error(
      "[shippo-webhook] SHIPPO_WEBHOOK_SECRET is not configured — rejecting (fail closed)",
    );
    return unauthorized();
  }

  const requestUrl = publicRequestUrl(request);
  if (!verifyShippoWebhookToken(requestUrl, secret)) {
    console.warn("[shippo-webhook] Invalid or missing token", {
      path: new URL(requestUrl).pathname,
    });
    return unauthorized();
  }

  const rawBody = await request.text();
  const idempotencyKey = deriveIdempotencyKey(
    "shippo",
    request.headers,
    rawBody,
  );
  const { isDuplicate } = checkIdempotency("shippo", idempotencyKey);
  if (isDuplicate) {
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  }

  try {
    const result = await handleShippoEvent(rawBody);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[shippo-webhook] Handler error", message);
    return NextResponse.json(
      { ok: true, handled: false, reason: "handler_error" },
      { status: 200 },
    );
  }
}
