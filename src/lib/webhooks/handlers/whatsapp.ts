import { classifyReply } from "@/lib/ai/tasks/reply-classify";
import { parseOrder } from "@/lib/ai/tasks/order-parse";
import { twilioWhatsAppAdapter } from "@/lib/channels/adapters/twilio-whatsapp";
import { normaliseAndPersist } from "@/lib/channels/normaliser";
import {
  cancelAwaitingPaymentOrder,
  cancelPendingDraft,
  confirmDraftOrder,
  findAwaitingPaymentForThread,
  findPendingDraftForThread,
} from "@/lib/orders/confirm-draft-order";
import { createDraftOrderFromParse } from "@/lib/orders/create-draft-order";
import { isAffirmativeReply, isNegativeReply } from "@/lib/orders/detect-reply";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  handleOtherFallback,
  handleQuestionReply,
} from "@/lib/support/handle-inbound";
import { notifySellerOfUnmatchedOrder } from "@/lib/support/notify-seller";
import { parseFormBody } from "@/lib/webhooks/verify/signatures";

export interface WhatsAppHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

type ReplyOutcome =
  | { handled: true; outcome: Record<string, unknown> }
  | { handled: false };

async function classifyInboundReply(text: string): Promise<{
  classification: "affirmative" | "negative" | "other";
  usedAi: boolean;
}> {
  if (isAffirmativeReply(text)) {
    return { classification: "affirmative", usedAi: false };
  }
  if (isNegativeReply(text)) {
    return { classification: "negative", usedAi: false };
  }
  const result = await classifyReply(text);
  return { classification: result.classification, usedAi: true };
}

/**
 * Pre-order_parse intercept: PENDING_CONFIRMATION (Step 10) first, then
 * AWAITING_PAYMENT. PENDING_CONFIRMATION behaviour is unchanged — corrections
 * still fall through to order_parse and update the same draft.
 *
 * AWAITING_PAYMENT: a clear cancel expires Checkout + releases the hold;
 * a change request falls through so Step 9 can supersede the unpaid order.
 */
async function tryHandleDraftReply(params: {
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string;
  messageText: string;
  supabase: ReturnType<typeof createAdminClient>;
}): Promise<ReplyOutcome> {
  const draft = await findPendingDraftForThread(
    params.supabase,
    params.businessId,
    params.threadId,
  );

  if (draft) {
    const { classification, usedAi } = await classifyInboundReply(
      params.messageText.trim(),
    );

    if (classification === "affirmative") {
      const outcome = await confirmDraftOrder({
        businessId: params.businessId,
        customerId: params.customerId,
        customerPhoneE164: params.customerPhoneE164,
        threadId: params.threadId,
        orderId: draft.id,
        usedAi,
        supabase: params.supabase,
      });
      const replyAction =
        outcome.action === "confirmed" ? "confirmed" : outcome.action;
      return {
        handled: true,
        outcome: { replyAction, usedAi, ...outcome },
      };
    }

    if (classification === "negative") {
      const outcome = await cancelPendingDraft(params.supabase, {
        businessId: params.businessId,
        customerId: params.customerId,
        customerPhoneE164: params.customerPhoneE164,
        threadId: params.threadId,
        orderId: draft.id,
      });
      return {
        handled: true,
        outcome: { replyAction: "cancelled", usedAi, ...outcome },
      };
    }

    // Corrections / questions fall through to order_parse (Step 9).
    return { handled: false };
  }

  const awaiting = await findAwaitingPaymentForThread(
    params.supabase,
    params.businessId,
    params.threadId,
  );
  if (!awaiting) {
    return { handled: false };
  }

  const { classification, usedAi } = await classifyInboundReply(
    params.messageText.trim(),
  );

  if (classification === "negative") {
    const outcome = await cancelAwaitingPaymentOrder({
      supabase: params.supabase,
      businessId: params.businessId,
      orderId: awaiting.id,
      notifyBuyer: true,
      customerId: params.customerId,
      customerPhoneE164: params.customerPhoneE164,
      threadId: params.threadId,
    });
    if (outcome.action === "error") {
      return {
        handled: true,
        outcome: {
          replyAction: "error",
          usedAi,
          previousStatus: "AWAITING_PAYMENT",
          ...outcome,
        },
      };
    }
    return {
      handled: true,
      outcome: {
        replyAction: "cancelled",
        usedAi,
        previousStatus: "AWAITING_PAYMENT",
        ...outcome,
      },
    };
  }

  // Change requests (and stray "yes") fall through to order_parse.
  return { handled: false };
}

/**
 * Handles a verified inbound Twilio WhatsApp webhook: parse → normalise →
 * resolve business/customer/thread → persist as an inbound message →
 * (Step 10) intercept affirmative/negative replies on open drafts, and
 * cancel an AWAITING_PAYMENT order when the buyer clearly declines →
 * catalog-grounded order_parse → for intent "order", create/update a
 * PENDING_CONFIRMATION draft (superseding an unpaid AWAITING_PAYMENT
 * order when one exists); for "question", a context-grounded support
 * reply (escalating to the seller when the answer isn't configured); for
 * "other", a fixed fallback.
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
      let draftOutcome: Record<string, unknown> | null = null;
      let replyOutcome: Record<string, unknown> | null = null;
      let supportOutcome: Record<string, unknown> | null = null;
      let unmatchedNotify: Record<string, unknown> | null = null;

      // Intercept yes/no on PENDING_CONFIRMATION, and cancel on
      // AWAITING_PAYMENT, BEFORE order_parse so corrections still parse.
      let replyHandled = false;
      try {
        const reply = await tryHandleDraftReply({
          businessId: result.message.businessId,
          customerId: result.message.customerId,
          customerPhoneE164: result.message.customerPhone,
          threadId: result.message.threadId,
          messageText: result.message.normalisedText,
          supabase,
        });
        if (reply.handled) {
          replyHandled = true;
          replyOutcome = reply.outcome;
          console.info("[whatsapp] draft-reply handled", {
            messageId: result.messageId,
            replyAction: reply.outcome.replyAction,
            usedAi: reply.outcome.usedAi,
          });
        }
      } catch (replyError) {
        const message =
          replyError instanceof Error ? replyError.message : String(replyError);
        console.error("[whatsapp] draft-reply failed — falling through to order_parse", {
          messageId: result.messageId,
          error: message,
        });
        replyOutcome = { replyAction: "error", error: message };
      }

      if (!replyHandled) {
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

            if (parseResult.needs_clarification) {
              try {
                const notify = await notifySellerOfUnmatchedOrder({
                  businessId: result.message.businessId,
                  customerPhoneE164: result.message.customerPhone,
                  buyerMessage: result.message.normalisedText,
                  supabase,
                });
                unmatchedNotify = { ...notify };
                console.info("[whatsapp] unmatched-order seller notify", {
                  messageId: result.messageId,
                  attempted: notify.attempted,
                  ok: notify.ok,
                });
              } catch (notifyError) {
                const message =
                  notifyError instanceof Error
                    ? notifyError.message
                    : String(notifyError);
                console.error("[whatsapp] unmatched-order seller notify failed", {
                  messageId: result.messageId,
                  error: message,
                });
                unmatchedNotify = { attempted: true, ok: false, error: message };
              }
            }

            if (parseResult.intent === "order") {
              // Step 9: draft confirmation / clarification. Failures are logged
              // but must not fail the inbound webhook.
              try {
                const outcome = await createDraftOrderFromParse({
                  businessId: result.message.businessId,
                  customerId: result.message.customerId,
                  customerPhoneE164: result.message.customerPhone,
                  threadId: result.message.threadId,
                  parseResult,
                  supabase,
                });
                draftOutcome = { ...outcome };
                console.info("[whatsapp] draft-order outcome", {
                  messageId: result.messageId,
                  action: outcome.action,
                });
              } catch (draftError) {
                const message =
                  draftError instanceof Error
                    ? draftError.message
                    : String(draftError);
                console.error("[whatsapp] draft-order failed", {
                  messageId: result.messageId,
                  error: message,
                });
                draftOutcome = { action: "error", error: message };
              }
            } else if (parseResult.intent === "question") {
              try {
                const outcome = await handleQuestionReply({
                  businessId: result.message.businessId,
                  customerId: result.message.customerId,
                  customerPhoneE164: result.message.customerPhone,
                  threadId: result.message.threadId,
                  messageText: result.message.normalisedText,
                  supabase,
                });
                supportOutcome = { ...outcome };
                console.info("[whatsapp] support-reply outcome", {
                  messageId: result.messageId,
                  action: outcome.action,
                  escalateToSeller: outcome.escalateToSeller,
                  aiCalled: outcome.aiCalled,
                });
                const { error: escalateStoreError } = await supabase
                  .from("messages")
                  .update({
                    ai_parse_result: {
                      ...parseResult,
                      escalate_to_seller: outcome.escalateToSeller,
                    },
                  })
                  .eq("id", result.messageId);
                if (escalateStoreError) {
                  console.error("[whatsapp] Failed to store escalate_to_seller", {
                    messageId: result.messageId,
                    error: escalateStoreError.message,
                  });
                }
              } catch (supportError) {
                const message =
                  supportError instanceof Error
                    ? supportError.message
                    : String(supportError);
                console.error("[whatsapp] support-reply failed", {
                  messageId: result.messageId,
                  error: message,
                });
                supportOutcome = { action: "error", error: message };
              }
            } else {
              try {
                const outcome = await handleOtherFallback({
                  businessId: result.message.businessId,
                  customerId: result.message.customerId,
                  customerPhoneE164: result.message.customerPhone,
                  threadId: result.message.threadId,
                  messageText: result.message.normalisedText,
                  supabase,
                });
                supportOutcome = { ...outcome };
                console.info("[whatsapp] other-fallback outcome", {
                  messageId: result.messageId,
                  action: outcome.action,
                  aiCalled: outcome.aiCalled,
                });
              } catch (fallbackError) {
                const message =
                  fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError);
                console.error("[whatsapp] other-fallback failed", {
                  messageId: result.messageId,
                  error: message,
                });
                supportOutcome = { action: "error", error: message };
              }
            }
          }
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
          console.error("[whatsapp] order_parse failed", {
            messageId: result.messageId,
            error: parseError,
          });
        }
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
        replyAction: replyOutcome?.replyAction ?? null,
        draftAction: draftOutcome?.action ?? null,
        supportAction: supportOutcome?.action ?? null,
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
          ...(replyOutcome ? { reply: replyOutcome } : {}),
          ...(draftOutcome ? { draft: draftOutcome } : {}),
          ...(supportOutcome ? { support: supportOutcome } : {}),
          ...(unmatchedNotify ? { unmatchedNotify } : {}),
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
