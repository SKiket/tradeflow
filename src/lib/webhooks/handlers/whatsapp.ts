import { parseOrder } from "@/lib/ai/tasks/order-parse";
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
 * resolve business/customer/thread → persist as an inbound message → run
 * catalog-grounded order_parse and store the result on the message row.
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
    case "persisted": {
      let parseStored = false;
      let parseError: string | null = null;

      // Run order_parse on every inbound customer message (simplest correct
      // default). Failures must not fail the webhook — the message is already
      // persisted.
      try {
        const parseResult = await parseOrder({
          businessId: result.message.businessId,
          messageText: result.message.normalisedText,
          threadId: result.message.threadId,
          supabase,
        });

        const { error: updateError } = await supabase
          .from("messages")
          .update({ ai_parse_result: parseResult })
          .eq("id", result.messageId);

        if (updateError) {
          parseError = updateError.message;
          console.error("[whatsapp] Failed to store ai_parse_result", {
            messageId: result.messageId,
            error: updateError.message,
          });
        } else {
          parseStored = true;
          console.info("[whatsapp] order_parse stored", {
            messageId: result.messageId,
            intent: parseResult.intent,
            confidence: parseResult.confidence,
            itemCount: parseResult.items.length,
            needsClarification: parseResult.needs_clarification,
          });
        }
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
        console.error("[whatsapp] order_parse failed", {
          messageId: result.messageId,
          error: parseError,
        });
      }

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
        parseStored,
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
          parseStored,
          ...(parseError ? { parseError } : {}),
        },
      };
    }

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
