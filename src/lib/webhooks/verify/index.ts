import type { WebhookSource } from "@/lib/webhooks/types";
import {
  isWebhookSecretConfigured,
  type WebhookVerificationResult,
} from "@/lib/webhooks/verify/config";
import {
  parseFormBody,
  verifyShippoSignature,
  verifyTwilioSignature,
} from "@/lib/webhooks/verify/signatures";
import { verifyStripeSignature } from "@/lib/webhooks/verify/stripe";

export async function verifyWebhookSignature(
  source: WebhookSource,
  rawBody: string,
  url: string,
  headers: Headers,
): Promise<WebhookVerificationResult> {
  switch (source) {
    case "twilio-whatsapp":
    case "twilio-sms": {
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      if (!authToken) {
        console.error("[webhook-auth] TWILIO_AUTH_TOKEN is not configured");
        return { valid: false, mode: "real" };
      }
      const valid = verifyTwilioSignature(
        authToken,
        headers.get("x-twilio-signature"),
        url,
        parseFormBody(rawBody),
      );
      return { valid, mode: "real" };
    }
    case "stripe": {
      // Real verification from day one — Stripe's signing secret is available
      // immediately on webhook creation, so there is no reason to stub this.
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        console.error("[webhook-auth] STRIPE_WEBHOOK_SECRET is not configured");
        return { valid: false, mode: "real" };
      }
      const valid = verifyStripeSignature(
        rawBody,
        headers.get("stripe-signature"),
        secret,
      );
      return { valid, mode: "real" };
    }
    case "shippo": {
      const secret = process.env.SHIPPO_WEBHOOK_SECRET;
      if (!isWebhookSecretConfigured(secret)) {
        console.warn("STUB: no Shippo webhook secret configured yet");
        return {
          valid: true,
          mode: "stub",
          stubReason: "SHIPPO_WEBHOOK_SECRET not configured",
        };
      }
      const valid = verifyShippoSignature(
        secret,
        rawBody,
        headers.get("shippo-auth-signature") ??
          headers.get("Shippo-Auth-Signature"),
      );
      return { valid, mode: "real" };
    }
    default:
      return { valid: false, mode: "real" };
  }
}
