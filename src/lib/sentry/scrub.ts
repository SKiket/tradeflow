import type { ErrorEvent, EventHint } from "@sentry/core";

/** E.164-ish and loose national phone patterns (no /g — avoid lastIndex bugs). */
const PHONE_RE =
  /(?:\+|00)?(?:\d[\s().-]?){8,15}\d|\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/;

const SENSITIVE_KEY_RE =
  /^(authorization|auth|cookie|set-cookie|x-api-key|api[_-]?key|password|secret|token|phone|whatsapp|body|message|text|content|payload|address|customer[_-]?name|full[_-]?name|name|email|stripe|twilio|raw[_-]?body|request[_-]?body)$/i;

const TWILIO_STRIPE_BODY_KEY_RE =
  /^(Body|SmsBody|MessageBody|data|object|payload|raw_payload|WebhookBody)$/i;

const MESSAGE_LIKE_RE =
  /\b(whatsapp|sms|message body|order is ready|please (send|reply)|hey\s+[A-Z])/i;

const ADDRESS_LIKE_RE =
  /\b\d{1,4}\s+[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,4}\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Close|Cl)\b/gi;

function scrubString(value: string): string {
  // Free-form WhatsApp / customer message content — drop wholesale.
  if (
    MESSAGE_LIKE_RE.test(value) ||
    (PHONE_RE.test(value) && value.length > 48)
  ) {
    return "[redacted-message]";
  }
  return value
    .replace(new RegExp(PHONE_RE.source, "g"), "[redacted-phone]")
    .replace(ADDRESS_LIKE_RE, "[redacted-address]");
}

function scrubDeep(value: unknown, keyHint = ""): unknown {
  if (value == null) return value;

  if (typeof value === "string") {
    if (SENSITIVE_KEY_RE.test(keyHint) || TWILIO_STRIPE_BODY_KEY_RE.test(keyHint)) {
      return "[redacted]";
    }
    return scrubString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, keyHint));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SENSITIVE_KEY_RE.test(key) || TWILIO_STRIPE_BODY_KEY_RE.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = scrubDeep(child, key);
    }
    return out;
  }

  return value;
}

function extractHttpStatus(event: ErrorEvent, hint?: EventHint): number | null {
  const responseStatus = event.contexts?.response?.status_code;
  if (typeof responseStatus === "number") return responseStatus;

  const extraStatus = event.extra?.status ?? event.extra?.statusCode;
  if (typeof extraStatus === "number") return extraStatus;

  const original = hint?.originalException;
  if (original && typeof original === "object") {
    const maybe = original as { status?: unknown; statusCode?: unknown };
    if (typeof maybe.status === "number") return maybe.status;
    if (typeof maybe.statusCode === "number") return maybe.statusCode;
  }

  return null;
}

/**
 * Drop expected client errors and scrub PII before send.
 * Keeps business_id tags; strips personal identifiers.
 */
export function scrubSentryEvent(
  event: ErrorEvent,
  hint?: EventHint,
): ErrorEvent | null {
  const status = extractHttpStatus(event, hint);
  if (status != null && status >= 400 && status < 500) {
    return null;
  }

  const businessId =
    (typeof event.tags?.business_id === "string" && event.tags.business_id) ||
    (typeof event.extra?.business_id === "string" && event.extra.business_id) ||
    null;

  if (event.message) {
    event.message = scrubString(event.message);
  }

  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = scrubString(ex.value);
      if (ex.type) ex.type = scrubString(ex.type);
    }
  }

  if (event.request) {
    if (event.request.headers) {
      const headers = { ...event.request.headers };
      for (const key of Object.keys(headers)) {
        if (SENSITIVE_KEY_RE.test(key)) {
          headers[key] = "[redacted]";
        } else if (typeof headers[key] === "string") {
          headers[key] = scrubString(headers[key] as string);
        }
      }
      event.request.headers = headers;
    }
    if (event.request.data != null) {
      event.request.data = scrubDeep(event.request.data, "body");
    }
    if (event.request.query_string) {
      event.request.query_string = scrubString(
        String(event.request.query_string),
      );
    }
    if (event.request.cookies) {
      event.request.cookies = { _redacted: "[redacted]" };
    }
  }

  if (event.user) {
    event.user = {
      id: event.user.id ? "[redacted]" : undefined,
    };
  }

  if (event.extra) {
    event.extra = scrubDeep(event.extra) as typeof event.extra;
  }

  if (event.contexts) {
    event.contexts = scrubDeep(event.contexts) as typeof event.contexts;
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      message: crumb.message ? scrubString(crumb.message) : crumb.message,
      data: crumb.data
        ? (scrubDeep(crumb.data) as Record<string, unknown>)
        : crumb.data,
    }));
  }

  event.tags = {
    ...(event.tags ?? {}),
  };
  delete event.tags.phone;
  delete event.tags.email;
  delete event.tags.username;
  if (businessId) {
    event.tags.business_id = businessId;
  }

  return event;
}

/** Shared Sentry.init options used by client/server/edge. */
export function sentrySharedOptions() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined;
  return {
    dsn,
    enabled: Boolean(dsn),
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
  };
}
