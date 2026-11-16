import {
  ALLERGENS_STATUSES,
  DELIVERY_INFO_MAX,
  FAQ_FIELD_MAX,
  KNOWLEDGE_FIELD_MAX,
  PRODUCT_FAQ_MAX,
  SHOP_FAQ_MAX,
  type AllergensStatus,
  type FaqItem,
} from "@/lib/knowledge/types";

function trimOrNull(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export function parseAllergensStatus(value: unknown): AllergensStatus {
  if (typeof value === "string" && ALLERGENS_STATUSES.includes(value as AllergensStatus)) {
    return value as AllergensStatus;
  }
  return "not_provided";
}

export function parseFaqArray(
  value: unknown,
  maxItems: number,
): { items: FaqItem[]; error?: string } {
  if (value == null || value === "") return { items: [] };
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return { items: [], error: "FAQ must be valid JSON" };
    }
  }
  if (!Array.isArray(raw)) {
    return { items: [], error: "FAQ must be an array" };
  }
  if (raw.length > maxItems) {
    return { items: [], error: `At most ${maxItems} FAQ items` };
  }
  const items: FaqItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const question = trimOrNull(rec.question, FAQ_FIELD_MAX);
    const answer = trimOrNull(rec.answer, FAQ_FIELD_MAX);
    if (!question || !answer) {
      return { items: [], error: "Each FAQ needs question and answer" };
    }
    items.push({ question, answer });
  }
  return { items };
}

export function normaliseProductKnowledge(input: {
  usage_instructions?: unknown;
  ingredients?: unknown;
  storage_and_care?: unknown;
  size_and_fit?: unknown;
  allergens_text?: unknown;
  allergens_status?: unknown;
  product_faqs?: unknown;
}): { ok: true; value: {
  usage_instructions: string | null;
  ingredients: string | null;
  storage_and_care: string | null;
  size_and_fit: string | null;
  allergens_text: string | null;
  allergens_status: AllergensStatus;
  product_faqs: FaqItem[];
} } | { ok: false; error: string } {
  const faqs = parseFaqArray(input.product_faqs, PRODUCT_FAQ_MAX);
  if (faqs.error) return { ok: false, error: faqs.error };

  const status = parseAllergensStatus(input.allergens_status);
  let allergensText = trimOrNull(input.allergens_text, KNOWLEDGE_FIELD_MAX);
  if (status !== "listed") allergensText = null;
  if (status === "listed" && !allergensText) {
    return { ok: false, error: "List the allergens when status is listed" };
  }

  return {
    ok: true,
    value: {
      usage_instructions: trimOrNull(input.usage_instructions, KNOWLEDGE_FIELD_MAX),
      ingredients: trimOrNull(input.ingredients, KNOWLEDGE_FIELD_MAX),
      storage_and_care: trimOrNull(input.storage_and_care, KNOWLEDGE_FIELD_MAX),
      size_and_fit: trimOrNull(input.size_and_fit, KNOWLEDGE_FIELD_MAX),
      allergens_text: allergensText,
      allergens_status: status,
      product_faqs: faqs.items,
    },
  };
}

export function normaliseShopKnowledge(input: {
  shop_faq?: unknown;
  delivery_info?: unknown;
}): { ok: true; value: { shop_faq: FaqItem[]; delivery_info: string | null } } | { ok: false; error: string } {
  const faqs = parseFaqArray(input.shop_faq, SHOP_FAQ_MAX);
  if (faqs.error) return { ok: false, error: faqs.error };
  return {
    ok: true,
    value: {
      shop_faq: faqs.items,
      delivery_info: trimOrNull(input.delivery_info, DELIVERY_INFO_MAX),
    },
  };
}
