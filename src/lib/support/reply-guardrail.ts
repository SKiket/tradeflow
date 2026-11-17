/**
 * Deterministic post-check on AI support_reply text before send.
 * Never leaves the buyer without a reply; never trusts the model for
 * allergen free-from / health claims.
 */

import type { AllergensStatus } from "@/lib/knowledge/types";

export type GuardrailProduct = {
  id: string;
  name: string;
  ingredients: string | null;
  allergens_status: AllergensStatus;
  allergens_text: string | null;
  usage_instructions: string | null;
  storage_and_care: string | null;
  size_and_fit: string | null;
};

export type GuardrailResult = {
  reply: string;
  escalateToSeller: boolean;
  blocked: boolean;
  reason: "allergen_claim" | "health_claim" | null;
  /** Product matched for gap logging when blocked (may be null). */
  productId: string | null;
  /** True when the allergy confirm footer was appended. */
  allergyFooterAppended: boolean;
};

/** EN/FR free-from / safe-for / does-not-contain style claims. */
const ALLERGEN_CLAIM_RE =
  /\b(nut[-\s]?free|gluten[-\s]?free|dairy[-\s]?free|lactose[-\s]?free|egg[-\s]?free|soy[-\s]?free|peanut[-\s]?free|vegan[-\s]?safe|allergy[-\s]?safe|safe\s+for\s+allerg(?:y|ies)|free\s+from|contains\s+no|does\s+not\s+contain|doesn't\s+contain|do\s+not\s+contain|without\s+(?:nuts?|gluten|dairy|lactose|peanuts?)|sans\s+gluten|sans\s+noix|sans\s+lactose|sans\s+lait|sans\s+arachides|ne\s+contient\s+pas|n['']?a\s+pas\s+de|convient\s+aux\s+allergiques)\b/iu;

const HEALTH_CLAIM_RE =
  /\b(cure[sd]?|curing|treat(?:s|ed|ing|ment)?|heal(?:s|ed|ing)?|prevent(?:s|ed|ing|ion)?|relieve[sd]?|relief|guérit|guerir|soigne|soigner|traite|traiter|prévient|previent|prévenir|prevenir|soulage|soulager)\b/iu;

const ALLERGEN_OR_INGREDIENT_TOPIC_RE =
  /\b(allergen|allergens|allerg(?:y|ies)|ingredient|ingredients|nuts?|nut[-\s]?free|gluten|dairy|lactose|peanuts?|vegan|sans\s+gluten|sans\s+noix|noix|arachides?|ingrédients?|allergène|allergènes)\b/iu;

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findClaimedProducts(
  reply: string,
  products: GuardrailProduct[],
): GuardrailProduct[] {
  const lower = reply.toLowerCase();
  const hits = products.filter((p) => {
    const name = p.name.trim().toLowerCase();
    return name.length >= 3 && lower.includes(name);
  });
  if (hits.length) return hits;
  // Fall back to all catalog products when the reply is generic ("it" / "the soap").
  return products;
}

function sellerKnowledgeText(product: GuardrailProduct): string {
  return [
    product.ingredients,
    product.allergens_text,
    product.usage_instructions,
    product.storage_and_care,
    product.size_and_fit,
  ]
    .filter(Boolean)
    .join("\n");
}

function allergenClaimAllowed(
  reply: string,
  product: GuardrailProduct,
): boolean {
  if (product.allergens_status === "not_provided") return false;

  const seller = normalizeForCompare(sellerKnowledgeText(product));
  if (!seller) return false;

  // Collect claim phrases from the reply and require each appears in seller text.
  const matches = reply.match(
    new RegExp(ALLERGEN_CLAIM_RE.source, ALLERGEN_CLAIM_RE.flags + "g"),
  );
  if (!matches?.length) return true;

  return matches.every((m) => seller.includes(normalizeForCompare(m)));
}

function healthClaimAllowed(reply: string, products: GuardrailProduct[]): boolean {
  const matches = reply.match(new RegExp(HEALTH_CLAIM_RE.source, HEALTH_CLAIM_RE.flags + "g"));
  if (!matches?.length) return true;

  const sellerBlob = normalizeForCompare(
    products.map(sellerKnowledgeText).join("\n"),
  );
  if (!sellerBlob) return false;

  return matches.every((m) => sellerBlob.includes(normalizeForCompare(m)));
}

export function replyTouchesAllergensOrIngredients(
  reply: string,
  buyerMessage?: string,
): boolean {
  return (
    ALLERGEN_OR_INGREDIENT_TOPIC_RE.test(reply) ||
    (buyerMessage ? ALLERGEN_OR_INGREDIENT_TOPIC_RE.test(buyerMessage) : false)
  );
}

/**
 * Post-check AI reply. Pure — no I/O. Caller supplies fixed handover / footer
 * strings already localized.
 */
export function applySupportReplyGuardrail(params: {
  reply: string;
  escalateToSeller: boolean;
  products: GuardrailProduct[];
  buyerMessage: string;
  handoverMessage: string;
  allergyConfirmFooter: string;
}): GuardrailResult {
  let reply = (params.reply || "").trim();
  let escalateToSeller = params.escalateToSeller;
  let blocked = false;
  let reason: GuardrailResult["reason"] = null;
  let productId: string | null = null;

  const relevant = findClaimedProducts(reply, params.products);

  if (ALLERGEN_CLAIM_RE.test(reply)) {
    const offending = relevant.find((p) => !allergenClaimAllowed(reply, p));
    if (offending || relevant.length === 0) {
      blocked = true;
      reason = "allergen_claim";
      productId = offending?.id ?? relevant[0]?.id ?? null;
      reply = params.handoverMessage;
      escalateToSeller = true;
    }
  }

  if (!blocked && HEALTH_CLAIM_RE.test(reply)) {
    if (!healthClaimAllowed(reply, relevant.length ? relevant : params.products)) {
      blocked = true;
      reason = "health_claim";
      productId = relevant[0]?.id ?? null;
      reply = params.handoverMessage;
      escalateToSeller = true;
    }
  }

  let allergyFooterAppended = false;
  if (
    replyTouchesAllergensOrIngredients(reply, params.buyerMessage) ||
    blocked
  ) {
    const footer = params.allergyConfirmFooter.trim();
    if (footer && !normalizeForCompare(reply).includes(normalizeForCompare(footer))) {
      reply = `${reply.trim()}\n\n${footer}`;
      allergyFooterAppended = true;
    }
  }

  return {
    reply,
    escalateToSeller,
    blocked,
    reason,
    productId,
    allergyFooterAppended,
  };
}

/** Test helpers — exported for unit/verify scripts. */
export const __guardrailPatterns = {
  ALLERGEN_CLAIM_RE,
  HEALTH_CLAIM_RE,
  ALLERGEN_OR_INGREDIENT_TOPIC_RE,
};
