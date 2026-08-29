import { NextResponse, type NextRequest } from "next/server";

import { handleStripeEvent } from "@/lib/webhooks/handlers/stripe";
import {
  deriveIdempotencyKey,
  handleVerifiedWebhook,
} from "@/lib/webhooks/handlers/stub";
import { handleTwilioWhatsApp } from "@/lib/webhooks/handlers/whatsapp";
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
  const rawBody = await request.text();
  const sourceHeader = resolveSource(request, rawBody);

  if (!isWebhookSource(sourceHeader)) {
    return badRequest("Missing or unrecognised webhook source");
  }
  const requestUrl = publicRequestUrl(request);

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

  // Inbound WhatsApp: normalise the verified payload into the messages table.
  if (sourceHeader === "twilio-whatsapp") {
    if (isDuplicate) {
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    }
    try {
      const result = await handleTwilioWhatsApp(rawBody);
      return NextResponse.json(result.body, { status: result.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[whatsapp] Handler error", message);
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
 * Determines the webhook source. Prefers an explicit X-Source header.
 *
 * Hosted providers cannot attach custom headers, so we also infer:
 *   - Stripe: Stripe-Signature header
 *   - Twilio WhatsApp: X-Twilio-Signature plus a whatsapp: From/To (or WaId)
 *   - Twilio SMS: X-Twilio-Signature without a WhatsApp address
 */
function resolveSource(
  request: NextRequest,
  rawBody: string,
): string | null {
  const explicit = request.headers.get("x-source");
  if (explicit) return explicit;
  if (request.headers.get("stripe-signature")) return "stripe";

  if (request.headers.get("x-twilio-signature")) {
    const params = parseFormBody(rawBody);
    if (isTwilioWhatsAppPayload(params)) return "twilio-whatsapp";
    return "twilio-sms";
  }

  return null;
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

function isTwilioWhatsAppPayload(params: Record<string, string>): boolean {
  const from = params.From ?? "";
  const to = params.To ?? "";
  if (/^whatsapp:/i.test(from) || /^whatsapp:/i.test(to)) return true;
  return typeof params.WaId === "string" && params.WaId.length > 0;
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
