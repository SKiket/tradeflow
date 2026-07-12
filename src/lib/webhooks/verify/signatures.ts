import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Parse application/x-www-form-urlencoded body into key/value map. */
export function parseFormBody(rawBody: string): Record<string, string> {
  const params = new URLSearchParams(rawBody);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

/**
 * Twilio X-Twilio-Signature verification (HMAC-SHA1, base64).
 * @see https://www.twilio.com/docs/usage/security#validating-requests
 */
export function verifyTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;

  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");

  return safeEqual(expected, signature);
}

/**
 * Shippo Shippo-Auth-Signature verification (HMAC-SHA256 hex).
 * Header format: t=<unix>,v1=<hex>
 * Signed string: `${timestamp}.${rawBody}`
 * @see https://docs.goshippo.com/docs/Tracking/WebhookSecurity
 */
export function verifyShippoSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key.trim(), rest.join("=").trim()];
    }),
  );

  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  return safeEqual(expected.toLowerCase(), signature.toLowerCase());
}

export function signTwilioForTest(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
}

export function signShippoForTest(secret: string, rawBody: string, timestamp: string): string {
  const signedPayload = `${timestamp}.${rawBody}`;
  const signature = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}
