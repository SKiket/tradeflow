import { NextResponse, type NextRequest } from "next/server";

import { handleStripeEvent } from "@/lib/webhooks/handlers/stripe";
import {
  deriveIdempotencyKey,
  handleVerifiedWebhook,
} from "@/lib/webhooks/handlers/stub";
import { checkIdempotency } from "@/lib/webhooks/idempotency";
import { isWebhookSource } from "@/lib/webhooks/types";
import { verifyWebhookSignature } from "@/lib/webhooks/verify";
import { parseFormBody } from "@/lib/webhooks/verify/signatures";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: NextRequest) {
  const sourceHeader = resolveSource(request);

  if (!isWebhookSource(sourceHeader)) {
    return badRequest("Missing or unrecognised X-Source header");
  }

  const rawBody = await request.text();
  const requestUrl = request.url;

  const verification = await verifyWebhookSignature(
    sourceHeader,
    rawBody,
    requestUrl,
    request.headers,
  );

  if (!verification.valid) {
    console.warn("[webhook-auth] Invalid signature attempt", {
      source: sourceHeader,
      mode: verification.mode,
      path: new URL(requestUrl).pathname,
    });
    return unauthorized();
  }

  const idempotencyKey = deriveIdempotencyKey(
    sourceHeader,
    request.headers,
    rawBody,
  );
  const { isDuplicate } = checkIdempotency(sourceHeader, idempotencyKey);

  // Stripe events get real processing (account.updated → sync capability
  // status). Duplicates are acknowledged without reprocessing.
  if (sourceHeader === "stripe") {
    if (isDuplicate) {
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    }
    try {
      const result = await handleStripeEvent(rawBody);
      return NextResponse.json(result.body, { status: result.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[stripe-webhook] Handler error", message);
      // Acknowledge so Stripe retries via a later event rather than flooding
      // the endpoint; never surface a 500 for a validly-signed event.
      return NextResponse.json(
        { ok: true, handled: false, reason: "handler_error" },
        { status: 200 },
      );
    }
  }

  const contentType = request.headers.get("content-type") ?? "text/plain";
  const payload = contentType.includes("application/x-www-form-urlencoded")
    ? parseFormBody(rawBody)
    : tryParseJson(rawBody);

  const result = handleVerifiedWebhook({
    source: sourceHeader,
    rawBody,
    contentType,
    headers: request.headers,
    url: requestUrl,
    idempotencyKey,
    isDuplicate,
    payload,
    verificationMode: verification.mode,
    stubReason: verification.stubReason,
  });

  return NextResponse.json(result.body, { status: result.status });
}

/**
 * Determines the webhook source. Prefers an explicit X-Source header, but
 * falls back to Stripe when a Stripe-Signature header is present — Stripe's
 * hosted webhook deliveries cannot attach custom headers.
 */
function resolveSource(request: NextRequest): string | null {
  const explicit = request.headers.get("x-source");
  if (explicit) return explicit;
  if (request.headers.get("stripe-signature")) return "stripe";
  return null;
}

function tryParseJson(rawBody: string): Record<string, string> {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      flat[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return flat;
  } catch {
    return {};
  }
}
