import type {
  ChannelAdapter,
  ParsedInboundMessage,
} from "@/lib/channels/types";

/** Strip Twilio's `whatsapp:` (or `sms:`) channel prefix, leaving E.164. */
function stripChannelPrefix(value: string): string {
  return value.replace(/^whatsapp:/i, "").replace(/^sms:/i, "").trim();
}

/**
 * Adapter for Twilio's inbound WhatsApp webhook.
 *
 * Twilio posts application/x-www-form-urlencoded with fields including:
 *   From (whatsapp:+<customer>), To (whatsapp:+<business number>), Body,
 *   MessageSid, ProfileName, NumMedia, MediaUrl0..N, MediaContentType0..N.
 *
 * @see https://www.twilio.com/docs/messaging/guides/webhook-request
 */
export const twilioWhatsAppAdapter: ChannelAdapter = {
  channel: "whatsapp",

  parse(rawPayload: Record<string, string>): ParsedInboundMessage {
    const from = rawPayload.From ?? "";
    const to = rawPayload.To ?? "";
    const body = rawPayload.Body ?? "";

    const mediaCount = Number.parseInt(rawPayload.NumMedia ?? "0", 10);
    const mediaUrls: string[] = [];
    if (Number.isFinite(mediaCount) && mediaCount > 0) {
      for (let i = 0; i < mediaCount; i += 1) {
        const url = rawPayload[`MediaUrl${i}`];
        if (url) mediaUrls.push(url);
      }
    }

    return {
      channel: "whatsapp",
      senderPhoneE164: stripChannelPrefix(from),
      recipientAddress: stripChannelPrefix(to),
      text: body,
      mediaUrls,
      providerMessageId: rawPayload.MessageSid ?? null,
      senderDisplayName: rawPayload.ProfileName?.trim() || null,
      rawPayload,
      receivedAt: new Date().toISOString(),
    };
  },
};
