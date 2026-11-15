import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isRateLimitFailure,
  isRetryableTwilioFailure,
  isStateDependentRetryContext,
  MAX_DELIVERY_ATTEMPTS,
  nextRetryAtIso,
  plainDeliveryReason,
  retryBackoffMinutes,
  shouldSkipRealTwilioSend,
  type DeliveryAudience,
  type DeliveryStatus,
  type RetryContext,
} from "@/lib/channels/send/delivery";
import {
  WhatsAppNotConfiguredError,
  WhatsAppSendError,
} from "@/lib/channels/send/errors";
import { isInServiceWindow } from "@/lib/channels/service-window";
import {
  buildContentVariablesForKey,
  isTemplatesEnabled,
  lookupApprovedTemplate,
} from "@/lib/channels/templates/lookup";
import type { TemplateKey } from "@/lib/channels/templates/registry";
import { createAdminClient } from "@/lib/supabase/admin";

export type SendMode = "freeform" | "template";

export interface WhatsAppTemplateParam {
  key: TemplateKey | string;
  variables: Record<string, string>;
}

export interface SendWhatsAppMessageParams {
  businessId: string;
  toPhoneE164: string;
  text: string;
  /** When replying in an existing conversation, pass the thread to keep. */
  threadId?: string | null;
  /** Optional; resolved from toPhoneE164 when omitted. */
  customerId?: string | null;
  supabase?: SupabaseClient;
  /** Defaults to buyer — seller alerts use "seller". */
  audience?: DeliveryAudience;
  /**
   * When retrying an existing failed outbound row, pass its id so the
   * row is updated in place instead of inserting a duplicate.
   */
  existingMessageId?: string | null;
  /** Stamped into raw_payload so retries can validate freshness. */
  retryContext?: RetryContext | null;
  /**
   * When false, never schedule outbound text retries (pending_replay owns
   * recovery). Defaults to true for plain notices.
   */
  scheduleOutboundRetry?: boolean;
  /**
   * Optional Meta/Twilio template for outside the 24h service window.
   * Ignored when TEMPLATES_ENABLED is not "true" or when still in-window.
   */
  template?: WhatsAppTemplateParam | null;
}

export interface SendWhatsAppMessageResult {
  sid: string;
  status: string;
  messageId: string;
  threadId: string;
  customerId: string;
  fromPhoneE164: string;
  deliveryStatus: DeliveryStatus;
  /** True when no Twilio HTTP call was made (test-range skip or dry-run). */
  simulated: boolean;
  sendMode: SendMode;
  templateKey: string | null;
}

/** Last Twilio request — used by dry-run / test mocks. */
export type TwilioSendRequest =
  | {
      kind: "freeform";
      from: string;
      to: string;
      body: string;
    }
  | {
      kind: "template";
      from: string;
      to: string;
      contentSid: string;
      contentVariables: Record<string, string>;
    };

let lastTwilioRequest: TwilioSendRequest | null = null;

export function getLastTwilioRequest(): TwilioSendRequest | null {
  return lastTwilioRequest;
}

export function clearLastTwilioRequest(): void {
  lastTwilioRequest = null;
}

type TwilioPoster = (
  req: TwilioSendRequest,
) => Promise<{ sid: string; status: string }>;

let twilioPosterOverride: TwilioPoster | null = null;

/** Test-only: replace the Twilio HTTP call. Pass null to restore. */
export function setTwilioPosterForTests(poster: TwilioPoster | null): void {
  twilioPosterOverride = poster;
}

function normaliseE164(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) {
    throw new WhatsAppSendError("toPhoneE164 must not be empty");
  }
  return trimmed.replace(/^whatsapp:/i, "");
}

function toWhatsAppAddress(phoneE164: string): string {
  return phoneE164.startsWith("whatsapp:") ? phoneE164 : `whatsapp:${phoneE164}`;
}

/**
 * Send a WhatsApp message via Twilio and persist it as an outbound row.
 *
 * When TEMPLATES_ENABLED=true and the buyer is outside the 24h service
 * window, uses an approved Content template instead of free-form Body.
 * Flag off → free-form only (unchanged behaviour).
 *
 * @throws {WhatsAppNotConfiguredError} when the business has no WhatsApp number
 * @throws {WhatsAppSendError} when Twilio rejects the send (after persisting failed row)
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
  const audience: DeliveryAudience = params.audience ?? "buyer";
  const retryContext = params.retryContext ?? null;
  const templateParam = params.template ?? null;

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
  const customer = await resolveCustomer(
    supabase,
    params.businessId,
    toPhoneE164,
    params.customerId,
  );
  const customerId = customer.id;
  const threadId = await resolveThreadId(
    supabase,
    params.businessId,
    customerId,
    params.threadId,
  );

  const priorMeta = params.existingMessageId
    ? await readOutboundMeta(supabase, params.existingMessageId)
    : {
        attempts: 0,
        queuedAt: null as string | null,
        retryContext: null as RetryContext | null,
      };
  const priorAttempts = priorMeta.attempts;
  const effectiveRetryContext = retryContext ?? priorMeta.retryContext;

  function withRetryContext(
    base: Record<string, unknown>,
  ): Record<string, unknown> {
    const stamped: Record<string, unknown> = {
      ...base,
      queued_at:
        priorMeta.queuedAt ??
        (typeof base.queued_at === "string"
          ? base.queued_at
          : new Date().toISOString()),
    };
    if (templateParam) {
      stamped.template = {
        key: templateParam.key,
        variables: templateParam.variables,
      };
    }
    if (!effectiveRetryContext) return stamped;
    return { ...stamped, retry_context: effectiveRetryContext };
  }

  const templatesOn = isTemplatesEnabled();
  const inWindow = isInServiceWindow({
    last_customer_message_at: customer.last_customer_message_at,
  });

  let sendMode: SendMode = "freeform";
  let templateKey: string | null = templateParam?.key ?? null;
  let contentSid: string | null = null;
  let contentVariables: Record<string, string> | null = null;

  if (templatesOn && !inWindow) {
    if (!templateParam?.key) {
      await failOutsideWindowNoTemplate({
        supabase,
        existingMessageId: params.existingMessageId,
        businessId: params.businessId,
        customerId,
        threadId,
        text,
        audience,
        priorAttempts,
        withRetryContext,
        templateKey: null,
      });
    }

    const approved = await lookupApprovedTemplate({
      supabase,
      key: templateParam!.key,
      language: customer.preferred_language,
      businessId: params.businessId,
    });

    if (!approved) {
      await failOutsideWindowNoTemplate({
        supabase,
        existingMessageId: params.existingMessageId,
        businessId: params.businessId,
        customerId,
        threadId,
        text,
        audience,
        priorAttempts,
        withRetryContext,
        templateKey: templateParam!.key,
      });
    }

    sendMode = "template";
    templateKey = approved!.template_key;
    contentSid = approved!.twilio_content_sid;
    contentVariables = buildContentVariablesForKey(
      templateParam!.key as TemplateKey,
      templateParam!.variables,
    );
  }

  const twilioRequest: TwilioSendRequest =
    sendMode === "template" && contentSid && contentVariables
      ? {
          kind: "template",
          from: toWhatsAppAddress(fromPhoneE164),
          to: toWhatsAppAddress(toPhoneE164),
          contentSid,
          contentVariables,
        }
      : {
          kind: "freeform",
          from: toWhatsAppAddress(fromPhoneE164),
          to: toWhatsAppAddress(toPhoneE164),
          body: text,
        };

  if (shouldSkipRealTwilioSend(toPhoneE164)) {
    lastTwilioRequest = null;
    const messageId = await persistOutbound(supabase, {
      existingMessageId: params.existingMessageId,
      businessId: params.businessId,
      customerId,
      threadId,
      text,
      audience,
      deliveryStatus: "simulated",
      attempts: priorAttempts + 1,
      sendMode,
      templateKey,
      rawPayload: withRetryContext({
        provider: "twilio",
        simulated: true,
        reason: "reserved_test_number",
        from: fromPhoneE164,
        to: toPhoneE164,
        send_mode: sendMode,
        template_key: templateKey,
        ...(sendMode === "template"
          ? {
              content_sid: contentSid,
              content_variables: contentVariables,
            }
          : {}),
      }),
    });
    console.info("[whatsapp-send] Simulated send (test number)", {
      messageId,
      to: toPhoneE164,
      businessId: params.businessId,
      sendMode,
      templateKey,
    });
    return {
      sid: `SIMULATED_${messageId}`,
      status: "simulated",
      messageId,
      threadId,
      customerId,
      fromPhoneE164,
      deliveryStatus: "simulated",
      simulated: true,
      sendMode,
      templateKey,
    };
  }

  let twilio: { sid: string; status: string };
  try {
    twilio = await postTwilioMessage(twilioRequest);
  } catch (error) {
    const sendError =
      error instanceof WhatsAppSendError
        ? error
        : new WhatsAppSendError(
            error instanceof Error ? error.message : String(error),
          );
    const attempts = priorAttempts + 1;
    const rateLimited = isRateLimitFailure({
      twilioCode: sendError.twilioCode,
      twilioStatus: sendError.twilioStatus,
    });
    const stateDependent = isStateDependentRetryContext(effectiveRetryContext);
    const allowTextRetry = params.scheduleOutboundRetry !== false;
    const retryable =
      allowTextRetry &&
      !stateDependent &&
      isRetryableTwilioFailure({
        twilioCode: sendError.twilioCode,
        twilioStatus: sendError.twilioStatus,
      }) &&
      attempts < MAX_DELIVERY_ATTEMPTS;
    const backoff = retryable
      ? retryBackoffMinutes({
          attemptJustFinished: attempts,
          rateLimited,
        })
      : null;
    const nextRetry =
      backoff != null && retryable ? nextRetryAtIso(backoff) : null;
    const plain = plainDeliveryReason({
      errorCode: sendError.twilioCode,
      errorMessage: sendError.message,
    });

    const messageId = await persistOutbound(supabase, {
      existingMessageId: params.existingMessageId,
      businessId: params.businessId,
      customerId,
      threadId,
      text,
      audience,
      deliveryStatus: "failed",
      attempts,
      sendMode,
      templateKey,
      errorCode:
        sendError.twilioCode != null ? String(sendError.twilioCode) : null,
      errorText: plain,
      nextRetryAt: nextRetry,
      rawPayload: withRetryContext({
        provider: "twilio",
        from: fromPhoneE164,
        to: toPhoneE164,
        error_code: sendError.twilioCode ?? null,
        error_message: sendError.message,
        http_status: sendError.twilioStatus ?? null,
        rate_limited: rateLimited,
        send_mode: sendMode,
        template_key: templateKey,
      }),
    });

    console.error("[whatsapp-send] Outbound send failed (persisted)", {
      messageId,
      businessId: params.businessId,
      to: toPhoneE164,
      twilioCode: sendError.twilioCode,
      attempts,
      nextRetryAt: nextRetry,
      sendMode,
      error: sendError.message,
    });

    throw new WhatsAppSendError(sendError.message, {
      twilioStatus: sendError.twilioStatus,
      twilioCode: sendError.twilioCode,
    });
  }

  const messageId = await persistOutbound(supabase, {
    existingMessageId: params.existingMessageId,
    businessId: params.businessId,
    customerId,
    threadId,
    text,
    audience,
    deliveryStatus: "sent",
    attempts: priorAttempts + 1,
    sendMode,
    templateKey,
    nextRetryAt: null,
    errorCode: null,
    errorText: null,
    rawPayload: withRetryContext({
      provider: "twilio",
      sid: twilio.sid,
      status: twilio.status,
      from: fromPhoneE164,
      to: toPhoneE164,
      send_mode: sendMode,
      template_key: templateKey,
      ...(sendMode === "template"
        ? {
            content_sid: contentSid,
            content_variables: contentVariables,
          }
        : {}),
    }),
  });

  console.info("[whatsapp-send] Outbound message sent", {
    sid: twilio.sid,
    status: twilio.status,
    messageId,
    businessId: params.businessId,
    threadId,
    to: toPhoneE164,
    sendMode,
    templateKey,
  });

  return {
    sid: twilio.sid,
    status: twilio.status,
    messageId,
    threadId,
    customerId,
    fromPhoneE164,
    deliveryStatus: "sent",
    simulated: twilio.sid.startsWith("DRYRUN_"),
    sendMode,
    templateKey,
  };
}

async function failOutsideWindowNoTemplate(params: {
  supabase: SupabaseClient;
  existingMessageId?: string | null;
  businessId: string;
  customerId: string;
  threadId: string;
  text: string;
  audience: DeliveryAudience;
  priorAttempts: number;
  withRetryContext: (base: Record<string, unknown>) => Record<string, unknown>;
  templateKey: string | null;
}): Promise<never> {
  const reasonCode = "outside_window_no_template";
  const plain = plainDeliveryReason({
    errorCode: reasonCode,
    errorMessage: reasonCode,
  });
  const messageId = await persistOutbound(params.supabase, {
    existingMessageId: params.existingMessageId,
    businessId: params.businessId,
    customerId: params.customerId,
    threadId: params.threadId,
    text: params.text,
    audience: params.audience,
    deliveryStatus: "failed",
    attempts: params.priorAttempts + 1,
    sendMode: null,
    templateKey: params.templateKey,
    errorCode: reasonCode,
    errorText: plain,
    nextRetryAt: null,
    rawPayload: params.withRetryContext({
      provider: "twilio",
      from: null,
      to: null,
      error_code: reasonCode,
      error_message: "Outside WhatsApp service window and no approved template",
      send_mode: null,
      template_key: params.templateKey,
    }),
  });

  console.error("[whatsapp-send] Outside window, no approved template", {
    messageId,
    businessId: params.businessId,
    templateKey: params.templateKey,
  });

  throw new WhatsAppSendError(
    "Outside WhatsApp service window and no approved template",
    { twilioCode: reasonCode },
  );
}

async function readOutboundMeta(
  supabase: SupabaseClient,
  messageId: string,
): Promise<{
  attempts: number;
  queuedAt: string | null;
  retryContext: RetryContext | null;
}> {
  const { data } = await supabase
    .from("messages")
    .select("delivery_attempts, raw_payload")
    .eq("id", messageId)
    .maybeSingle();
  const raw =
    data?.raw_payload && typeof data.raw_payload === "object"
      ? (data.raw_payload as Record<string, unknown>)
      : {};
  const queuedAt = typeof raw.queued_at === "string" ? raw.queued_at : null;
  const retryCtx = raw.retry_context;
  let parsed: RetryContext | null = null;
  if (retryCtx && typeof retryCtx === "object") {
    parsed = retryCtx as RetryContext;
  }
  return {
    attempts:
      typeof data?.delivery_attempts === "number" ? data.delivery_attempts : 0,
    queuedAt,
    retryContext: parsed,
  };
}

async function persistOutbound(
  supabase: SupabaseClient,
  params: {
    existingMessageId?: string | null;
    businessId: string;
    customerId: string;
    threadId: string;
    text: string;
    audience: DeliveryAudience;
    deliveryStatus: DeliveryStatus;
    attempts: number;
    errorCode?: string | null;
    errorText?: string | null;
    nextRetryAt?: string | null;
    sendMode?: SendMode | null;
    templateKey?: string | null;
    rawPayload: Record<string, unknown>;
  },
): Promise<string> {
  const row = {
    business_id: params.businessId,
    customer_id: params.customerId,
    channel: "whatsapp" as const,
    direction: "outbound" as const,
    normalised_text: params.text,
    thread_id: params.threadId,
    raw_payload: params.rawPayload,
    media_urls: null as string[] | null,
    delivery_status: params.deliveryStatus,
    delivery_error_code: params.errorCode ?? null,
    delivery_error_text: params.errorText ?? null,
    delivery_attempts: params.attempts,
    next_retry_at: params.nextRetryAt ?? null,
    delivery_audience: params.audience,
    send_mode: params.sendMode ?? null,
    template_key: params.templateKey ?? null,
  };

  if (params.existingMessageId) {
    const { data, error } = await supabase
      .from("messages")
      .update(row)
      .eq("id", params.existingMessageId)
      .select("id")
      .single();
    if (error || !data) {
      console.error("[whatsapp-send] Failed to update outbound row", {
        messageId: params.existingMessageId,
        error: error?.message,
      });
      return params.existingMessageId;
    }
    return data.id as string;
  }

  const { data, error } = await supabase
    .from("messages")
    .insert(row)
    .select("id")
    .single();

  if (error || !data) {
    console.error("[whatsapp-send] DB persist failed", {
      error: error?.message ?? "no row returned",
      deliveryStatus: params.deliveryStatus,
    });
    return "";
  }
  return data.id as string;
}

async function resolveCustomer(
  supabase: SupabaseClient,
  businessId: string,
  phoneE164: string,
  provided: string | null | undefined,
): Promise<{
  id: string;
  preferred_language: string | null;
  last_customer_message_at: string | null;
}> {
  if (provided) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, preferred_language, last_customer_message_at")
      .eq("id", provided)
      .maybeSingle();
    if (error) {
      throw new WhatsAppSendError(`Customer lookup failed: ${error.message}`);
    }
    if (data) {
      return {
        id: data.id as string,
        preferred_language: (data.preferred_language as string | null) ?? null,
        last_customer_message_at:
          (data.last_customer_message_at as string | null) ?? null,
      };
    }
  }

  const { data: existing, error } = await supabase
    .from("customers")
    .select("id, preferred_language, last_customer_message_at")
    .eq("business_id", businessId)
    .eq("phone_e164", phoneE164)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new WhatsAppSendError(`Customer lookup failed: ${error.message}`);
  }
  if (existing) {
    return {
      id: existing.id as string,
      preferred_language: (existing.preferred_language as string | null) ?? null,
      last_customer_message_at:
        (existing.last_customer_message_at as string | null) ?? null,
    };
  }

  const { data: created, error: insertError } = await supabase
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: phoneE164,
      channel_identifiers: { whatsapp: phoneE164 },
    })
    .select("id, preferred_language, last_customer_message_at")
    .single();

  if (created) {
    return {
      id: created.id as string,
      preferred_language: (created.preferred_language as string | null) ?? null,
      last_customer_message_at:
        (created.last_customer_message_at as string | null) ?? null,
    };
  }

  const { data: raced } = await supabase
    .from("customers")
    .select("id, preferred_language, last_customer_message_at")
    .eq("business_id", businessId)
    .eq("phone_e164", phoneE164)
    .maybeSingle();
  if (raced) {
    return {
      id: raced.id as string,
      preferred_language: (raced.preferred_language as string | null) ?? null,
      last_customer_message_at:
        (raced.last_customer_message_at as string | null) ?? null,
    };
  }

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

async function postTwilioMessage(
  req: TwilioSendRequest,
): Promise<{ sid: string; status: string }> {
  lastTwilioRequest = req;

  if (twilioPosterOverride) {
    return twilioPosterOverride(req);
  }

  const simulatedCode = process.env.TWILIO_SIMULATE_ERROR?.trim();
  if (simulatedCode) {
    const code = Number(simulatedCode) || simulatedCode;
    throw new WhatsAppSendError(
      code === 63038 || simulatedCode === "63038"
        ? "Account exceeded the 50 daily messages limit"
        : `Simulated Twilio error ${simulatedCode}`,
      {
        twilioStatus: simulatedCode === "63038" || code === 63038 ? 429 : 400,
        twilioCode: code,
      },
    );
  }

  if (process.env.TWILIO_DRY_RUN === "true") {
    const sid = `DRYRUN_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    return { sid, status: "queued" };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new WhatsAppSendError(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be configured",
    );
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({
    From: req.from,
    To: req.to,
  });
  if (req.kind === "template") {
    body.set("ContentSid", req.contentSid);
    body.set("ContentVariables", JSON.stringify(req.contentVariables));
  } else {
    body.set("Body", req.body);
  }

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
