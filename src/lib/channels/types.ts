/**
 * Channel normalisation contracts (Spec Section 6.4).
 *
 * Every inbound-message channel (WhatsApp now; SMS/TikTok/Instagram/Email in
 * Phase 3) parses its provider-specific payload into a single ParsedInbound
 * message, which the normaliser then resolves against a business, customer and
 * thread to produce a NormalisedMessage ready to persist.
 */

export type MessageChannel =
  | "whatsapp"
  | "sms"
  | "tiktok"
  | "instagram"
  | "email";

export type MessageDirection = "inbound" | "outbound";

/**
 * Provider-agnostic output of a channel adapter, before the message is tied to
 * a specific business/customer/thread. `recipientAddress` identifies which of
 * our connected channel endpoints received the message (used to resolve the
 * owning business); for WhatsApp this is the receiving phone number in E.164.
 */
export interface ParsedInboundMessage {
  channel: MessageChannel;
  senderPhoneE164: string;
  recipientAddress: string;
  text: string;
  mediaUrls: string[];
  providerMessageId: string | null;
  senderDisplayName: string | null;
  rawPayload: Record<string, unknown>;
  receivedAt: string;
}

/**
 * Fully-resolved message shape (Spec Section 6.4), ready to persist to the
 * messages table.
 */
export interface NormalisedMessage {
  businessId: string;
  customerId: string;
  customerPhone: string;
  channel: MessageChannel;
  direction: MessageDirection;
  rawPayload: Record<string, unknown>;
  normalisedText: string;
  mediaUrls: string[];
  threadId: string;
  receivedAt: string;
}

/**
 * A channel adapter turns a raw provider payload into a ParsedInboundMessage.
 * Adapters are pure — they do no I/O and no DB resolution.
 */
export interface ChannelAdapter {
  readonly channel: MessageChannel;
  parse(rawPayload: Record<string, string>): ParsedInboundMessage;
}
