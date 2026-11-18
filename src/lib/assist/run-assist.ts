import type { SupabaseClient } from "@supabase/supabase-js";

import { draftSellerReply } from "@/lib/ai/tasks/reply-draft";
import { polishSellerReply } from "@/lib/ai/tasks/reply-polish";
import { loadAllowedShopUrls } from "@/lib/assist/allowed-urls";
import type { NewDetailHit } from "@/lib/assist/new-details";
import { loadInboxAssistContext } from "@/lib/assist/load-inbox-context";
import { postCheckAssistSuggestion } from "@/lib/assist/post-check";
import { scrubAssistObject, scrubAssistText } from "@/lib/assist/scrub";
import {
  assertUnderAssistLimit,
  incrementAssistUsage,
} from "@/lib/assist/usage";
import { t } from "@/lib/i18n";

export type AssistMock = {
  suggestion?: string;
  translated?: boolean;
  suggestion_language?: string;
  fail?: boolean;
  overLimit?: boolean;
};

export type AssistOk = {
  ok: true;
  action: "polish" | "draft";
  suggestion: string;
  original: string;
  translated: boolean;
  translationLabel: string | null;
  placeholders: string[];
  newDetails: NewDetailHit[];
  sellerNeeded: boolean;
  /** Scrubbed payload sent to (or prepared for) the model — for verify only. */
  scrubbedPayload: Record<string, unknown>;
};

export type AssistFail = {
  ok: false;
  error: string;
  code: "over_limit" | "ai_failed" | "empty" | "not_found";
  scrubbedPayload?: Record<string, unknown>;
};

export async function runInboxAssist(params: {
  supabase: SupabaseClient;
  businessId: string;
  threadId: string;
  action: "polish" | "draft";
  sellerText: string;
  uiLang: string;
  mock?: AssistMock | null;
}): Promise<AssistOk | AssistFail> {
  const { data: threadRows, error: threadError } = await params.supabase
    .from("messages")
    .select("customer_id")
    .eq("thread_id", params.threadId)
    .eq("business_id", params.businessId)
    .not("customer_id", "is", null)
    .is("deleted_at", null)
    .limit(1);

  if (threadError) {
    return { ok: false, error: threadError.message, code: "not_found" };
  }
  const customerId = threadRows?.[0]?.customer_id as string | undefined;
  if (!customerId) {
    return { ok: false, error: "Thread not found", code: "not_found" };
  }

  if (params.action === "polish" && !params.sellerText.trim()) {
    return {
      ok: false,
      error: "Write a reply first.",
      code: "empty",
    };
  }

  if (params.mock?.overLimit) {
    return {
      ok: false,
      error: friendlyFail(params.uiLang, params.action),
      code: "over_limit",
    };
  }

  const limit = await assertUnderAssistLimit(
    params.supabase,
    params.businessId,
  );
  if (!limit.ok) {
    return {
      ok: false,
      error: friendlyFail(params.uiLang, params.action),
      code: "over_limit",
    };
  }

  const ctx = await loadInboxAssistContext({
    supabase: params.supabase,
    businessId: params.businessId,
    threadId: params.threadId,
    customerId,
  });

  const scrubbedDraft = scrubAssistText(params.sellerText);
  const scrubbedPayload = scrubAssistObject({
    action: params.action,
    sellerDraft: scrubbedDraft,
    customerLanguage: ctx.customerLanguage,
    customerFirstName: ctx.customerFirstName,
    recentMessages: scrubAssistText(ctx.recentMessages),
    contextBlob: scrubAssistText(ctx.contextBlob),
  });

  // Privacy assert helper for callers / verify.
  const payloadJson = JSON.stringify(scrubbedPayload);
  if (
    /\[redacted-phone\]|\[redacted-email\]|\[redacted-address\]/.test(
      payloadJson,
    ) === false &&
    /(?:\+|00)?\d[\d\s().-]{7,}\d|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
      payloadJson,
    )
  ) {
    // Extra scrub pass if anything leaked.
    scrubbedPayload.sellerDraft = scrubAssistText(
      String(scrubbedPayload.sellerDraft ?? ""),
    );
    scrubbedPayload.recentMessages = scrubAssistText(
      String(scrubbedPayload.recentMessages ?? ""),
    );
    scrubbedPayload.contextBlob = scrubAssistText(
      String(scrubbedPayload.contextBlob ?? ""),
    );
  }

  let rawSuggestion = "";
  let translated = false;
  let suggestionLanguage = ctx.customerLanguage ?? "unknown";

  try {
    if (params.mock?.fail) {
      throw new Error("mock_ai_fail");
    }
    if (params.mock?.suggestion != null) {
      rawSuggestion = params.mock.suggestion;
      translated = params.mock.translated === true;
      suggestionLanguage =
        params.mock.suggestion_language ?? suggestionLanguage;
    } else if (params.action === "polish") {
      const polished = await polishSellerReply({
        sellerDraft: String(scrubbedPayload.sellerDraft),
        customerLanguage: ctx.customerLanguage,
        recentMessages: String(scrubbedPayload.recentMessages),
        contextBlob: String(scrubbedPayload.contextBlob),
        customerFirstName: ctx.customerFirstName,
      });
      rawSuggestion = polished.suggestion;
      translated = polished.translated;
      suggestionLanguage = polished.suggestion_language;
    } else {
      const drafted = await draftSellerReply({
        customerLanguage: ctx.customerLanguage,
        recentMessages: String(scrubbedPayload.recentMessages),
        contextBlob: String(scrubbedPayload.contextBlob),
        customerFirstName: ctx.customerFirstName,
      });
      rawSuggestion = drafted.suggestion;
      translated = false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[assist] AI failed", {
      action: params.action,
      businessId: params.businessId,
      error: message,
    });
    return {
      ok: false,
      error: friendlyFail(params.uiLang, params.action),
      code: "ai_failed",
      scrubbedPayload,
    };
  }

  if (!rawSuggestion.trim()) {
    return {
      ok: false,
      error: friendlyFail(params.uiLang, params.action),
      code: "ai_failed",
      scrubbedPayload,
    };
  }

  const allowedUrls = await loadAllowedShopUrls(
    params.supabase,
    params.businessId,
  );
  const checked = postCheckAssistSuggestion({
    suggestion: rawSuggestion,
    sellerOriginal: params.sellerText,
    contextBlob: ctx.contextBlob,
    allowedUrls,
    products: ctx.products,
    buyerMessage: ctx.recentMessages,
    handoverMessage: t("support.seller_will_confirm", params.uiLang),
    allergyConfirmFooter: t("support.allergy_confirm_footer", params.uiLang),
  });

  await incrementAssistUsage(params.supabase, params.businessId);

  // Log usage only — never message content.
  console.info("[assist] ok", {
    action: params.action,
    businessId: params.businessId,
    translated,
    placeholderCount: checked.placeholders.length,
    newDetailCount: checked.newDetails.length,
    allergenBlocked: checked.allergenBlocked,
  });

  const translationLabel =
    translated && suggestionLanguage
      ? translationLabelFor(params.uiLang, suggestionLanguage)
      : null;

  return {
    ok: true,
    action: params.action,
    suggestion: checked.suggestion,
    original: params.sellerText,
    translated,
    translationLabel,
    placeholders: checked.placeholders,
    newDetails: checked.newDetails,
    sellerNeeded: ctx.sellerNeeded,
    scrubbedPayload,
  };
}

function friendlyFail(uiLang: string, action: "polish" | "draft"): string {
  if (uiLang.toLowerCase().startsWith("fr")) {
    return action === "polish"
      ? "Impossible de peaufiner pour le moment. Vous pouvez toujours envoyer votre message."
      : "Impossible de proposer une réponse pour le moment. Vous pouvez toujours écrire et envoyer.";
  }
  return action === "polish"
    ? "Couldn't polish right now. You can still send your message."
    : "Couldn't suggest a reply right now. You can still write and send.";
}

function translationLabelFor(uiLang: string, target: string): string {
  const code = target.toLowerCase().slice(0, 2);
  const fr = uiLang.toLowerCase().startsWith("fr");
  if (code === "fr") return fr ? "Traduit en français" : "Translated to French";
  if (code === "en") return fr ? "Traduit en anglais" : "Translated to English";
  return fr ? `Traduit (${code})` : `Translated (${code})`;
}
