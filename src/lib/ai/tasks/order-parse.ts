import type { JSONSchema7 } from "json-schema";
import type { SupabaseClient } from "@supabase/supabase-js";

import { run } from "@/lib/ai/gateway";
import {
  fetchActiveCatalog,
  type CatalogProduct,
} from "@/lib/products/catalog";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Structured output for taskKey "order_parse".
 *
 * Nullable string fields may come back as null or "" depending on the model;
 * callers should treat both as absent.
 */
export interface OrderParseItem {
  product_query: string;
  variant_query: string | null;
  quantity: number;
  matched_product_id: string | null;
  matched_variant_id: string | null;
  match_confidence: number;
}

export interface OrderParseResult {
  intent: "order" | "question" | "other";
  confidence: number;
  items: OrderParseItem[];
  needs_clarification: boolean;
  clarification_message: string | null;
}

export const ORDER_PARSE_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      description: 'One of: "order", "question", "other"',
    },
    confidence: {
      type: "number",
      description: "Overall parse confidence from 0 to 1",
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          product_query: { type: "string" },
          variant_query: { type: "string" },
          quantity: { type: "number" },
          matched_product_id: { type: "string" },
          matched_variant_id: { type: "string" },
          match_confidence: { type: "number" },
        },
        required: [
          "product_query",
          "variant_query",
          "quantity",
          "matched_product_id",
          "matched_variant_id",
          "match_confidence",
        ],
        additionalProperties: false,
      },
    },
    needs_clarification: { type: "boolean" },
    clarification_message: { type: "string" },
  },
  required: [
    "intent",
    "confidence",
    "items",
    "needs_clarification",
    "clarification_message",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are TradeFlow's order-parsing assistant for a small commerce business.

Given a customer's latest inbound message, recent thread context, and the business's ACTIVE product catalog, you must:

1. Classify intent as exactly one of: "order", "question", "other".
2. Extract any order line items the customer is requesting (including corrections to earlier items in the thread).
3. Match each item ONLY against the supplied catalog. Never invent a product or variant that is not listed. If nothing matches, leave matched_product_id and matched_variant_id as null (or empty string) and set a low match_confidence.
4. Set needs_clarification to true (and write a clear clarification_message) when the match is ambiguous, the referenced item is not in the catalog, quantity/variant is unclear, or a follow-up correction cannot be applied confidently.
5. For non-order messages (questions, greetings, other), set intent accordingly, leave items as [], and set needs_clarification false unless you genuinely need to ask something back.
   - After-sales status/tracking questions (e.g. "where's my order?", "when will this arrive?") are intent "question", not "order" or "other".
   - Complaints and problems (damaged, wrong item, missing, unhappy) are also intent "question" so they can be handled by support — not "other".

Rules:
- match_confidence and confidence are numbers between 0 and 1.
- quantity must be a positive number; default to 1 if the customer does not specify.
- Use thread context for follow-ups like "actually make it size 11" — apply the correction to the prior order intent rather than treating the message in isolation.
- For nullable fields (variant_query, matched_product_id, matched_variant_id, clarification_message) use null or an empty string when absent.
- Respond with JSON matching the schema exactly.`;

interface ThreadMessage {
  direction: string;
  normalised_text: string | null;
  created_at: string;
}

const THREAD_CONTEXT_LIMIT = 8;

/**
 * Parse an inbound customer message into a catalog-grounded structured result.
 * Does not create orders — only classifies and matches.
 */
export async function parseOrder(params: {
  businessId: string;
  messageText: string;
  threadId: string;
  supabase?: SupabaseClient;
}): Promise<OrderParseResult> {
  const supabase = params.supabase ?? createAdminClient();

  const [catalog, threadMessages] = await Promise.all([
    fetchActiveCatalog(supabase, params.businessId),
    fetchThreadContext(supabase, params.businessId, params.threadId),
  ]);

  const userPrompt = buildUserPrompt({
    messageText: params.messageText,
    catalog,
    threadMessages,
  });

  const gatewayResult = await run({
    taskKey: "order_parse",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: ORDER_PARSE_SCHEMA,
  });

  return normaliseParseResult(gatewayResult.data);
}

async function fetchThreadContext(
  supabase: SupabaseClient,
  businessId: string,
  threadId: string,
): Promise<ThreadMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("direction, normalised_text, created_at")
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(THREAD_CONTEXT_LIMIT);

  if (error) {
    throw new Error(`order_parse thread lookup failed: ${error.message}`);
  }

  // Oldest → newest so the model reads chronologically.
  return ((data as ThreadMessage[] | null) ?? []).reverse();
}

function buildUserPrompt(input: {
  messageText: string;
  catalog: CatalogProduct[];
  threadMessages: ThreadMessage[];
}): string {
  const catalogJson = JSON.stringify(
    input.catalog.map((product) => ({
      product_id: product.id,
      name: product.name,
      description: product.description,
      price_pence: product.price_pence,
      variants: product.variants.map((variant) => ({
        variant_id: variant.id,
        label: variant.label,
        stock_quantity: variant.stock_quantity,
      })),
    })),
    null,
    2,
  );

  const threadBlock =
    input.threadMessages.length === 0
      ? "(no prior messages in this thread)"
      : input.threadMessages
          .map(
            (message) =>
              `[${message.direction}] ${message.normalised_text ?? ""}`,
          )
          .join("\n");

  return `ACTIVE CATALOG (match only against these ids):
${catalogJson}

THREAD CONTEXT (oldest to newest; the latest inbound is also included):
${threadBlock}

LATEST CUSTOMER MESSAGE TO PARSE:
${input.messageText}`;
}

function nullishString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function clamp01(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normaliseParseResult(data: unknown): OrderParseResult {
  const record = (data ?? {}) as Record<string, unknown>;
  const intentRaw = typeof record.intent === "string" ? record.intent : "other";
  const intent: OrderParseResult["intent"] =
    intentRaw === "order" || intentRaw === "question" || intentRaw === "other"
      ? intentRaw
      : "other";

  const itemsRaw = Array.isArray(record.items) ? record.items : [];
  const items: OrderParseItem[] = itemsRaw.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const quantity =
      typeof row.quantity === "number" && row.quantity > 0 ? row.quantity : 1;
    return {
      product_query:
        typeof row.product_query === "string" ? row.product_query : "",
      variant_query: nullishString(row.variant_query),
      quantity,
      matched_product_id: nullishString(row.matched_product_id),
      matched_variant_id: nullishString(row.matched_variant_id),
      match_confidence: clamp01(row.match_confidence),
    };
  });

  return {
    intent,
    confidence: clamp01(record.confidence),
    items,
    needs_clarification: record.needs_clarification === true,
    clarification_message: nullishString(record.clarification_message),
  };
}
