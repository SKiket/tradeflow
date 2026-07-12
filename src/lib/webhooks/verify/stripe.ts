import { getStripe } from "@/lib/stripe/client";

/**
 * Stripe webhook signature verification.
 *
 * Uses the official SDK's constructEvent, which validates the
 * `Stripe-Signature` header (HMAC-SHA256 over `${timestamp}.${payload}`)
 * against STRIPE_WEBHOOK_SECRET and enforces the timestamp tolerance.
 *
 * @see https://docs.stripe.com/webhooks#verify-official-libraries
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
): boolean {
  if (!signatureHeader) return false;

  try {
    getStripe().webhooks.constructEvent(
      rawBody,
      signatureHeader,
      webhookSecret,
    );
    return true;
  } catch {
    // Invalid signature, malformed header, or timestamp outside tolerance.
    return false;
  }
}
