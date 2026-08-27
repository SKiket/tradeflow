import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  WhatsAppNotConfiguredError,
  WhatsAppSendError,
} from "@/lib/channels/send/errors";
import { createAdminClient } from "@/lib/supabase/admin";

export interface SendWhatsAppMessageParams {
  businessId: string;
  toPhoneE164: string;
  text: string;
  /** When replying in an existing conversation, pass the thread to keep. */
  threadId?: string | null;
  /** Optional; resolved from toPhoneE164 when omitted. */
  customerId?: string | null;
  supabase?: SupabaseClient;
}

export interface SendWhatsAppMessageResult {
  sid: string;
  status: string;
  messageId: string;
  threadId: string;
  customerId: string;
  fromPhoneE164: string;
}

function normaliseE164(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) {
    throw new WhatsAppSendError("toPhoneE164 must not be empty");
  }
  // Accept bare E.164 or a whatsapp:-prefixed value from callers.
  return trimmed.replace(/^whatsapp:/i, "");
}

function toWhatsAppAddress(phoneE164: string): string {
  return phoneE164.startsWith("whatsapp:") ? phoneE164 : `whatsapp:${phoneE164}`;
}

/**
 * Send a free-form WhatsApp text message via Twilio and persist it as an
 * outbound row on the messages table (same thread as the conversation when
 * provided / resolvable).
 *
 * Template messages (for outside the 24h service window) are Phase 2 — this
 * only sends free-form replies valid inside an open customer care window.
 *
 * @throws {WhatsAppNotConfiguredError} when the business has no WhatsApp number
 * @throws {WhatsAppSendError} when Twilio rejects the send or credentials are missing
 */
export async function sendWhatsAppMessage(
  params: SendWhatsAppMessageParams,
): Promise<SendWhatsAppMessageResult> {
  const text = params.text.trim();
  if (!text) {
    throw new WhatsAppSendError("Message text must not be empty");
  }

  const toPhoneE164 = normaliseE164(params.toPhoneE164);
  const supabase = params.supabase ?? createAdminClient();

  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id, whatsapp_phone_e164")
    .eq("id", params.businessId)
    .is("deleted_at", null)
    .maybeSingle();

  if (businessError) {
    throw new WhatsAppSendError(
      `Failed to look up business: ${businessError.message}`,
    );
  }
  if (!business) {
    throw new WhatsAppSendError(`Business ${params.businessId} not found`);
  }
  if (!business.whatsapp_phone_e164) {
    throw new WhatsAppNotConfiguredError(params.businessId);
  }

  const fromPhoneE164 = business.whatsapp_phone_e164;
  const customerId = await resolveCustomerId(
    supabase,
    params.businessId,
    toPhoneE164,
    params.customerId,
  );
  const threadId = await resolveThreadId(
    supabase,
    params.businessId,
    customerId,
    params.threadId,
  );

  const twilio = await postTwilioMessage({
    from: toWhatsAppAddress(fromPhoneE164),
    to: toWhatsAppAddress(toPhoneE164),
    body: text,
  });

  const { data: inserted, error: insertError } = await supabase
    .from("messages")
    .insert({
      business_id: params.businessId,
      customer_id: customerId,
      channel: "whatsapp",
      direction: "outbound",
      normalised_text: text,
      thread_id: threadId,
      raw_payload: {
        provider: "twilio",
        sid: twilio.sid,
        status: twilio.status,
        from: fromPhoneE164,
        to: toPhoneE164,
      },
      media_urls: null,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    // Twilio already accepted the message — log and still return success so
    // callers don't retry and double-send. The SID is the source of truth.
    console.error("[whatsapp-send] Twilio send succeeded but DB persist failed", {
      sid: twilio.sid,
      error: insertError?.message ?? "no row returned",
    });
    return {
      sid: twilio.sid,
      status: twilio.status,
      messageId: "",
      threadId,
      customerId,
      fromPhoneE164,
    };
  }

  console.info("[whatsapp-send] Outbound message sent", {
    sid: twilio.sid,
    status: twilio.status,
    messageId: inserted.id,
    businessId: params.businessId,
    threadId,
    to: toPhoneE164,
  });

  return {
    sid: twilio.sid,
    status: twilio.status,
    messageId: inserted.id,
    threadId,
    customerId,
    fromPhoneE164,
  };
}

async function resolveCustomerId(
  supabase: SupabaseClient,
  businessId: string,
  phoneE164: string,
  provided: string | null | undefined,
): Promise<string> {
  if (provided) return provided;

  const { data: existing, error } = await supabase
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", phoneE164)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new WhatsAppSendError(`Customer lookup failed: ${error.message}`);
  }
  if (existing) return existing.id;

  const { data: created, error: insertError } = await supabase
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: phoneE164,
      channel_identifiers: { whatsapp: phoneE164 },
    })
    .select("id")
    .single();

  if (created) return created.id;

  const { data: raced } = await supabase
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", phoneE164)
    .maybeSingle();
  if (raced) return raced.id;

  throw new WhatsAppSendError(
    `Customer create failed: ${insertError?.message ?? "unknown"}`,
  );
}

async function resolveThreadId(
  supabase: SupabaseClient,
  businessId: string,
  customerId: string,
  provided: string | null | undefined,
): Promise<string> {
  if (provided) return provided;

  const { data: latest, error } = await supabase
    .from("messages")
    .select("thread_id")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .not("thread_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new WhatsAppSendError(`Thread lookup failed: ${error.message}`);
  }
  if (latest?.thread_id) return latest.thread_id;

  return randomUUID();
}

async function postTwilioMessage(params: {
  from: string;
  to: string;
  body: string;
}): Promise<{ sid: string; status: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new WhatsAppSendError(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be configured",
    );
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({
    From: params.from,
    To: params.to,
    Body: params.body,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : `Twilio Messages API returned ${response.status}`;
    throw new WhatsAppSendError(message, {
      twilioStatus: response.status,
      twilioCode:
        typeof payload.code === "number" || typeof payload.code === "string"
          ? payload.code
          : undefined,
    });
  }

  const sid = typeof payload.sid === "string" ? payload.sid : null;
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  if (!sid) {
    throw new WhatsAppSendError("Twilio response missing message SID");
  }

  return { sid, status };
}
