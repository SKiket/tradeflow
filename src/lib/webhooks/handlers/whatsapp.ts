import { twilioWhatsAppAdapter } from "@/lib/channels/adapters/twilio-whatsapp";
import { normaliseAndPersist } from "@/lib/channels/normaliser";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseFormBody } from "@/lib/webhooks/verify/signatures";

export interface WhatsAppHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Handles a verified inbound Twilio WhatsApp webhook: parse → normalise →
 * resolve business/customer/thread → persist as an inbound message.
 *
 * Runs in unauthenticated webhook context, so it uses the service-role client.
 * Every outcome is acknowledged with 200 (with a clear log) so Twilio does not
 * enter a retry loop; transient failures are surfaced in logs.
 */
export async function handleTwilioWhatsApp(
  rawBody: string,
): Promise<WhatsAppHandlerResult> {
  const params = parseFormBody(rawBody);
  const parsed = twilioWhatsAppAdapter.parse(params);
  const supabase = createAdminClient();

  const result = await normaliseAndPersist(parsed, supabase);

  switch (result.status) {
    case "persisted":
      console.info("[whatsapp] Inbound message normalised", {
        messageId: result.messageId,
        businessId: result.message.businessId,
        customerId: result.message.customerId,
        customerPhone: result.message.customerPhone,
        threadId: result.message.threadId,
        customerCreated: result.customerCreated,
        threadCreated: result.threadCreated,
        mediaCount: result.message.mediaUrls.length,
        hasText: result.message.normalisedText.length > 0,
      });
      return {
        status: 200,
        body: {
          ok: true,
          handled: true,
          messageId: result.messageId,
          businessId: result.message.businessId,
          customerId: result.message.customerId,
          threadId: result.message.threadId,
          customerCreated: result.customerCreated,
          mediaCount: result.message.mediaUrls.length,
        },
      };

    case "unresolved_business":
      console.warn("[whatsapp] No business for receiving number", {
        recipient: result.recipientAddress,
      });
      return {
        status: 200,
        body: {
          ok: true,
          handled: false,
          reason: "unresolved_business",
          recipient: result.recipientAddress,
        },
      };

    case "error":
      console.error("[whatsapp] Normalisation failed", { reason: result.reason });
      return {
        status: 200,
        body: { ok: true, handled: false, reason: result.reason },
      };
  }
}
