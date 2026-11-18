import { findNewDetails, type NewDetailHit } from "@/lib/assist/new-details";
import { findPlaceholders } from "@/lib/assist/placeholders";
import {
  applySupportReplyGuardrail,
  type GuardrailProduct,
} from "@/lib/support/reply-guardrail";
import { stripInventedUrls } from "@/lib/support/shop-link-share";

export type AssistPostCheckResult = {
  suggestion: string;
  placeholders: string[];
  newDetails: NewDetailHit[];
  allergenBlocked: boolean;
  urlsStripped: boolean;
};

/**
 * Post-process an AI suggestion: strip invented URLs, allergen/health
 * guardrail, new-details warnings, placeholder scan.
 */
export function postCheckAssistSuggestion(params: {
  suggestion: string;
  sellerOriginal: string;
  contextBlob: string;
  allowedUrls: string[];
  products: GuardrailProduct[];
  buyerMessage: string;
  handoverMessage: string;
  allergyConfirmFooter: string;
}): AssistPostCheckResult {
  const beforeUrls = params.suggestion.trim();
  let suggestion = stripInventedUrls(beforeUrls, params.allowedUrls);
  const urlsStripped = suggestion !== beforeUrls && beforeUrls.includes("http");

  const guarded = applySupportReplyGuardrail({
    reply: suggestion,
    escalateToSeller: false,
    products: params.products,
    buyerMessage: params.buyerMessage,
    handoverMessage: params.handoverMessage,
    allergyConfirmFooter: params.allergyConfirmFooter,
  });
  suggestion = guarded.reply;

  const allowedSource = `${params.sellerOriginal}\n${params.contextBlob}`;
  const newDetails = findNewDetails(suggestion, allowedSource);
  const placeholders = findPlaceholders(suggestion);

  return {
    suggestion,
    placeholders,
    newDetails,
    allergenBlocked: guarded.blocked,
    urlsStripped,
  };
}
