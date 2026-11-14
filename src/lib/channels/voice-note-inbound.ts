import type { SupabaseClient } from "@supabase/supabase-js";

import { transcribeAudio } from "@/lib/ai/tasks/audio-transcribe";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import {
  downloadTwilioMedia,
  firstMediaContentType,
  isAudioOnlyInbound,
  TwilioMediaError,
} from "@/lib/channels/twilio-media";
import {
  SOURCE_KIND_VOICE_NOTE,
  voiceHeardPrefix,
} from "@/lib/channels/voice-note";
import { t } from "@/lib/i18n";
import {
  getCustomerPreferredLanguage,
  maybeUpdatePreferredLanguage,
} from "@/lib/i18n/language";

export type VoiceNoteInboundOutcome =
  | {
      kind: "not_audio";
    }
  | {
      kind: "rejected_too_long";
      buyerSend: { ok: boolean; messageId?: string; error?: string };
    }
  | {
      kind: "unclear";
      transcript: string;
      confidence: "high" | "medium" | "low";
      language: string;
      buyerSend: { ok: boolean; messageId?: string; error?: string };
    }
  | {
      kind: "ready";
      transcript: string;
      confidence: "high" | "medium" | "low";
      language: string;
      buyerReplyPrefix: string;
    }
  | {
      kind: "error";
      error: string;
      buyerSend?: { ok: boolean; messageId?: string; error?: string };
    };

/**
 * Detect audio-only inbound, download from Twilio (in memory only),
 * transcribe via audio_transcribe, and update the message row with the
 * transcript + source_kind = voice_note.
 *
 * Does not run order_parse — the caller continues the existing pipeline
 * when kind === "ready".
 */
export async function handleVoiceNoteInbound(params: {
  messageId: string;
  businessId: string;
  customerId: string;
  customerPhoneE164: string;
  threadId: string;
  text: string;
  mediaUrls: string[];
  rawPayload: Record<string, unknown>;
  /** When true, store transcript but do not send buyer WhatsApp replies. */
  skipBuyerReplies: boolean;
  supabase: SupabaseClient;
}): Promise<VoiceNoteInboundOutcome> {
  if (
    !isAudioOnlyInbound({
      text: params.text,
      mediaUrls: params.mediaUrls,
      rawPayload: params.rawPayload,
    })
  ) {
    return { kind: "not_audio" };
  }

  const mimeType = firstMediaContentType(params.rawPayload) ?? "audio/ogg";
  const mediaUrl = params.mediaUrls[0];
  const lang = await getCustomerPreferredLanguage(
    params.supabase,
    params.customerId,
  );

  let downloaded;
  try {
    downloaded = await downloadTwilioMedia({
      url: mediaUrl,
      mimeType,
    });
  } catch (error) {
    if (
      error instanceof TwilioMediaError &&
      (error.code === "too_large" || error.code === "too_long")
    ) {
      const buyerSend = params.skipBuyerReplies
        ? { ok: true }
        : await trySendFixed(
            params,
            t("voice.too_long", lang),
            "voice too long",
          );
      await params.supabase
        .from("messages")
        .update({
          source_kind: SOURCE_KIND_VOICE_NOTE,
          ai_parse_result: {
            voice_note: true,
            rejected: error.code,
            transcribed: false,
          },
        })
        .eq("id", params.messageId);
      return { kind: "rejected_too_long", buyerSend };
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("[voice-note] media download failed", {
      messageId: params.messageId,
      error: message,
    });
    return { kind: "error", error: message };
  }

  let transcription;
  try {
    transcription = await transcribeAudio({
      audio: downloaded.buffer,
      mimeType: downloaded.mimeType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[voice-note] transcription failed", {
      messageId: params.messageId,
      error: message,
    });
    const buyerSend = params.skipBuyerReplies
      ? { ok: true }
      : await trySendFixed(params, t("voice.unclear", lang), "voice unclear");
    await params.supabase
      .from("messages")
      .update({
        source_kind: SOURCE_KIND_VOICE_NOTE,
        normalised_text: "",
        ai_parse_result: {
          voice_note: true,
          transcribed: false,
          error: message,
        },
      })
      .eq("id", params.messageId);
    return {
      kind: "unclear",
      transcript: "",
      confidence: "low",
      language: "",
      buyerSend,
    };
  }

  const { transcript, confidence, language } = transcription;
  const unclear = transcript.length === 0 || confidence === "low";

  await params.supabase
    .from("messages")
    .update({
      source_kind: SOURCE_KIND_VOICE_NOTE,
      normalised_text: transcript,
      ai_parse_result: unclear
        ? {
            voice_note: true,
            transcribed: true,
            transcript,
            language,
            confidence,
            skipped_order_parse: true,
            reason: "low_confidence_or_empty",
          }
        : {
            voice_note: true,
            transcribed: true,
            language,
            confidence,
          },
    })
    .eq("id", params.messageId);

  if (unclear) {
    const buyerSend = params.skipBuyerReplies
      ? { ok: true }
      : await trySendFixed(params, t("voice.unclear", lang), "voice unclear");
    return {
      kind: "unclear",
      transcript,
      confidence,
      language,
      buyerSend,
    };
  }

  const replyLang = await maybeUpdatePreferredLanguage({
    supabase: params.supabase,
    customerId: params.customerId,
    messageText: transcript,
    detectedLanguage: language,
  });

  return {
    kind: "ready",
    transcript,
    confidence,
    language,
    buyerReplyPrefix: voiceHeardPrefix(transcript, replyLang),
  };
}

async function trySendFixed(
  params: {
    businessId: string;
    customerId: string;
    customerPhoneE164: string;
    threadId: string;
    supabase: SupabaseClient;
  },
  text: string,
  label: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    const sent = await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: params.customerPhoneE164,
      text,
      threadId: params.threadId,
      customerId: params.customerId,
      supabase: params.supabase,
    });
    return { ok: true, messageId: sent.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[voice-note] ${label} send failed`, {
      businessId: params.businessId,
      error: message,
    });
    return { ok: false, error: message };
  }
}
