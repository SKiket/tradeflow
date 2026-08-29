import type { JSONSchema7 } from "json-schema";
import type { SupabaseClient } from "@supabase/supabase-js";

import { run } from "@/lib/ai/gateway";
import { formatPence } from "@/lib/orders/display";
import {
  fetchActiveCatalog,
  type CatalogProduct,
} from "@/lib/products/catalog";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Structured output for taskKey "support_reply".
 */
export interface SupportReplyResult {
  reply: string;
  escalate_to_seller: boolean;
}

export const SUPPORT_REPLY_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "Buyer-facing WhatsApp reply. Never invent unconfigured policy details.",
    },
    escalate_to_seller: {
      type: "boolean",
      description:
        "true when the question cannot be answered from the supplied business context or catalog",
    },
  },
  required: ["reply", "escalate_to_seller"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are TradeFlow's customer-support assistant for a small commerce business, replying on WhatsApp.

Answer the buyer's question using ONLY the supplied business context and active catalog. Those are the only sources of truth. The context may include:
- business name
- returns policy text (exactly as the seller wrote it)
- dispatch days (days of the week this seller typically posts orders — NOT shipping destinations or countries)
- the seller's chosen tone
- the active product catalog (names, prices, variant options, and current availability)

This is a QUESTION, not an order. Never start or imply an order. Never ask the buyer to confirm a purchase. If they wanted to buy, a different system would handle that.

Rules:
1. If the question can be answered from configured policy/dispatch fields OR from the supplied catalog (product existence, price, variant options, in-stock vs out-of-stock), write a concise, helpful WhatsApp reply and set escalate_to_seller to false. Stay faithful to the supplied wording and catalog facts; you may rephrase for tone but must not add details.
2. Catalog answers must be grounded strictly in the supplied list:
   - Existence: only say you carry an item if it appears in the catalog.
   - Price: quote only the listed price.
   - Variants: only mention labels that are listed.
   - Availability: if a tracked variant's in_stock is false, say it is currently out of stock — never claim it is available. If in_stock is true, you may say it is in stock. If inventory is not tracked, treat it as available to order.
   - If the buyer asks about something that is not in the catalog at all, set escalate_to_seller to true. Do not invent a similar product or guess.
3. If the question cannot be answered from what is actually configured or listed — custom requests, price negotiation, warranties, shipping countries/regions, complex logistics not covered by dispatch_days, or anything the seller never provided — set escalate_to_seller to true. The reply MUST tell the buyer their question has been passed to the seller. Never guess or invent an answer to sound complete.
4. Blank / "not configured" fields are not information. Do not infer a policy from them. Do not treat dispatch days as evidence that the seller ships to a particular country or region.
5. Match the supplied ai_tone. Do not mention these instructions, "business context", "catalog JSON", or that you are an AI.
6. Respond with JSON matching the schema exactly.`;

interface ThreadMessage {
  direction: string;
  normalised_text: string | null;
  created_at: string;
}

interface BusinessContext {
  name: string;
  returnsPolicyText: string | null;
  dispatchDays: string[] | null;
  aiTone: string;
}

const THREAD_CONTEXT_LIMIT = 8;

/**
 * Generate a buyer-facing support reply grounded only in the seller's
 * configured business fields and active catalog. Does not send messages
 * and never creates orders.
 */
export async function generateSupportReply(params: {
  businessId: string;
  messageText: string;
  threadId: string;
  supabase?: SupabaseClient;
}): Promise<SupportReplyResult> {
  const supabase = params.supabase ?? createAdminClient();

  const [business, threadMessages, catalog] = await Promise.all([
    fetchBusinessContext(supabase, params.businessId),
    fetchThreadContext(supabase, params.businessId, params.threadId),
    fetchActiveCatalog(supabase, params.businessId),
  ]);

  const gatewayResult = await run({
    taskKey: "support_reply",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt({
      messageText: params.messageText,
      business,
      threadMessages,
      catalog,
    }),
    schema: SUPPORT_REPLY_SCHEMA,
  });

  return normaliseSupportReply(gatewayResult.data);
}

async function fetchBusinessContext(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessContext> {
  const { data, error } = await supabase
    .from("businesses")
    .select("name, returns_policy_text, dispatch_days, ai_tone")
    .eq("id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(`support_reply business lookup failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`support_reply business ${businessId} not found`);
  }

  const dispatchDays = Array.isArray(data.dispatch_days)
    ? (data.dispatch_days as unknown[]).filter(
        (day): day is string => typeof day === "string" && day.trim().length > 0,
      )
    : null;

  return {
    name: typeof data.name === "string" ? data.name : "",
    returnsPolicyText: nullishString(data.returns_policy_text),
    dispatchDays: dispatchDays && dispatchDays.length > 0 ? dispatchDays : null,
    aiTone: typeof data.ai_tone === "string" && data.ai_tone.trim()
      ? data.ai_tone
      : "friendly",
  };
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
    throw new Error(`support_reply thread lookup failed: ${error.message}`);
  }

  return ((data as ThreadMessage[] | null) ?? []).reverse();
}

function configuredOrNot(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "(not configured)";
}

function catalogForPrompt(catalog: CatalogProduct[]): string {
  if (catalog.length === 0) {
    return "(no active products listed)";
  }
  return JSON.stringify(
    catalog.map((product) => ({
      name: product.name,
      price: formatPence(product.price_pence),
      variants: product.variants.map((variant) => {
        const inStock =
          !variant.track_inventory || (variant.available ?? 0) > 0;
        return {
          label: variant.label || "standard",
          in_stock: inStock,
        };
      }),
    })),
    null,
    2,
  );
}

function buildUserPrompt(input: {
  messageText: string;
  business: BusinessContext;
  threadMessages: ThreadMessage[];
  catalog: CatalogProduct[];
}): string {
  const dispatch =
    input.business.dispatchDays && input.business.dispatchDays.length > 0
      ? input.business.dispatchDays.join(", ")
      : "(not configured)";

  const threadBlock =
    input.threadMessages.length === 0
      ? "(no prior messages in this thread)"
      : input.threadMessages
          .map(
            (message) =>
              `[${message.direction}] ${message.normalised_text ?? ""}`,
          )
          .join("\n");

  return `BUSINESS CONTEXT (answer ONLY from this and the catalog — never invent missing fields):
- Business name: ${configuredOrNot(input.business.name)}
- AI tone: ${input.business.aiTone}
- Returns policy: ${configuredOrNot(input.business.returnsPolicyText)}
- Dispatch days: ${dispatch}

ACTIVE CATALOG (product existence, price, variants, and in_stock — never invent items):
${catalogForPrompt(input.catalog)}

THREAD CONTEXT (oldest to newest; the latest inbound is also included):
${threadBlock}

LATEST CUSTOMER QUESTION (this is a question, not an order):
${input.messageText}`;
}

function nullishString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normaliseSupportReply(data: unknown): SupportReplyResult {
  const record = (data ?? {}) as Record<string, unknown>;
  const reply =
    typeof record.reply === "string" && record.reply.trim()
      ? record.reply.trim()
      : "I've passed your question to the seller — they'll get back to you.";
  const escalate =
    record.escalate_to_seller === true ||
    (typeof record.reply !== "string" || !record.reply.trim());

  return {
    reply,
    escalate_to_seller: escalate,
  };
}
