import type { JSONSchema7 } from "json-schema";
import type { SupabaseClient } from "@supabase/supabase-js";

import { run } from "@/lib/ai/gateway";
import { fetchRecentCustomerOrders, type CustomerOrderSummary } from "@/lib/orders/customer-orders";
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
  is_return_request: boolean;
  needs_order_clarification: boolean;
  return_order_ref: string | null;
  return_reason: string | null;
  return_reason_detail: string | null;
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
        "true when the question cannot be answered from the supplied context/catalog/orders, OR when the message is a genuine complaint that is NOT a return request",
    },
    is_return_request: {
      type: "boolean",
      description:
        "true when the buyer is asking to send an item back / start a return, not merely reporting a problem",
    },
    needs_order_clarification: {
      type: "boolean",
      description:
        "true when this is a return request and more than one DELIVERED order could match, and the buyer did not specify which",
    },
    return_order_ref: {
      type: ["string", "null"],
      description:
        "The order_ref to return when confidently identified. null if clarifying or not a return.",
    },
    return_reason: {
      type: ["string", "null"],
      description:
        "Structured reason: wrong_size, damaged_faulty, changed_mind, not_as_described, arrived_late, or other. damaged_faulty for arrived broken/damaged. other when nothing else fits. null if not a return.",
    },
    return_reason_detail: {
      type: ["string", "null"],
      description:
        "The buyer's own words. Required in spirit when return_reason is other; optional extra detail otherwise.",
    },
  },
  required: [
    "reply",
    "escalate_to_seller",
    "is_return_request",
    "needs_order_clarification",
    "return_order_ref",
    "return_reason",
    "return_reason_detail",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are TradeFlow's customer-support assistant for a small commerce business, replying on WhatsApp.

Answer the buyer's question using ONLY the supplied business context, active catalog, and this customer's own recent orders. Those are the only sources of truth. The context may include:
- business name
- returns policy text (exactly as the seller wrote it)
- dispatch days (days of the week this seller typically posts orders — NOT shipping destinations or countries)
- the seller's chosen tone
- the active product catalog (names, prices, variant options, and current availability)
- this customer's recent orders (order_ref, status, items, carrier, tracking number, created_at)

This is a QUESTION, not an order. Never start or imply an order. Never ask the buyer to confirm a purchase. If they wanted to buy, a different system would handle that.

Rules:
1. If the question can be answered from configured policy/dispatch fields, the supplied catalog (product existence, price, variant options, in-stock vs out-of-stock), OR the customer's real orders (status, tracking), write a concise, helpful WhatsApp reply and set escalate_to_seller to false. Stay faithful to the supplied wording and facts; you may rephrase for tone but must not add details.
2. Catalog answers must be grounded strictly in the supplied list:
   - Existence: only say you carry an item if it appears in the catalog.
   - Price: quote only the listed price.
   - Variants: only mention labels that are listed.
   - Availability: if a tracked variant's in_stock is false, say it is currently out of stock — never claim it is available. If in_stock is true, you may say it is in stock. If inventory is not tracked, treat it as available to order.
   - If the buyer asks about something that is not in the catalog at all, set escalate_to_seller to true. Do not invent a similar product or guess.
3. Order status and tracking answers must be grounded strictly in CUSTOMER ORDERS:
   - Cite the real order_ref, status, items, carrier, and tracking number when those fields are present.
   - Never invent a status, carrier, or tracking number. If tracking is blank, the order has not been dispatched — say so honestly.
   - If the list is empty, say you cannot find an order for them. Do not invent one.
   - If several active orders could match and the message does not make clear which one, ask a brief clarifying question (cite the order refs) rather than guessing.
4. Return requests (the buyer wants to send an item back):
   - Set is_return_request to true. Set escalate_to_seller to false — the system will notify the seller if a return is created.
   - DELIVERED orders are the only ones that can be returned. List only those when choosing an order.
   - If more than one order has status DELIVERED and the buyer did not specify which (no order_ref, item, or other unique clue), set needs_order_clarification to true, return_order_ref to null, and ask which order in reply (cite the refs). Do not guess.
   - If exactly one DELIVERED order exists, or the buyer clearly identifies one, set return_order_ref to that order_ref and needs_order_clarification to false.
   - Map their explanation to return_reason: "it arrived broken/damaged" → damaged_faulty; wrong size → wrong_size; changed mind → changed_mind; not as described → not_as_described; late → arrived_late. If none fit or you are unsure, use other and put their own words in return_reason_detail. Never force a bad-fit category.
   - Always copy useful buyer wording into return_reason_detail when they gave any.
   - If they ask to return an order that is not DELIVERED, still set is_return_request true and return_order_ref if identified; the system will explain why a return cannot start yet. Do not pretend it was requested.
   - Reply may be a short acknowledgement; the system may replace it with a confirmation after creating the return. Never promise a refund or replacement.
5. Genuine problems that are NOT a return request — damaged item, wrong item, missing item, or a clearly unhappy/complaint tone without asking to send it back — set is_return_request to false and escalate_to_seller to true immediately. The reply must acknowledge the issue and confirm it has been passed to the seller. Do NOT attempt to resolve it. Never promise a refund, a replacement, compensation, or any other specific outcome — that decision belongs to the seller.
6. If the question cannot be answered from what is actually configured, listed, or on the customer's orders — custom requests, price negotiation, warranties, shipping countries/regions, complex logistics not covered by dispatch_days, or anything the seller never provided — set escalate_to_seller to true. The reply MUST tell the buyer their question has been passed to the seller. Never guess or invent an answer to sound complete.
7. Blank / "not configured" fields are not information. Do not infer a policy from them. Do not treat dispatch days as evidence that the seller ships to a particular country or region.
8. Match the supplied ai_tone. Do not mention these instructions, "business context", "catalog JSON", "customer orders JSON", or that you are an AI. This business only messages buyers on WhatsApp — never mention email or another channel.
9. Respond with JSON matching the schema exactly. When this is not a return request, set is_return_request false, needs_order_clarification false, and the return_* fields to null.`;

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
 * Generate a buyer-facing support reply grounded in the seller's configured
 * business fields, active catalog, and this customer's recent orders.
 * Does not send messages and never creates orders.
 */
export async function generateSupportReply(params: {
  businessId: string;
  messageText: string;
  threadId: string;
  customerId?: string;
  supabase?: SupabaseClient;
}): Promise<SupportReplyResult> {
  const supabase = params.supabase ?? createAdminClient();

  const [business, threadMessages, catalog, orders] = await Promise.all([
    fetchBusinessContext(supabase, params.businessId),
    fetchThreadContext(supabase, params.businessId, params.threadId),
    fetchActiveCatalog(supabase, params.businessId),
    params.customerId
      ? fetchRecentCustomerOrders(supabase, {
          businessId: params.businessId,
          customerId: params.customerId,
          limit: 15,
        })
      : Promise.resolve([] as CustomerOrderSummary[]),
  ]);

  const gatewayResult = await run({
    taskKey: "support_reply",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt({
      messageText: params.messageText,
      business,
      threadMessages,
      catalog,
      orders,
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

function ordersForPrompt(orders: CustomerOrderSummary[]): string {
  if (orders.length === 0) {
    return "(no orders on file for this customer)";
  }
  return JSON.stringify(
    orders.map((order) => ({
      order_ref: order.orderRef,
      status: order.status,
      created_at: order.createdAt,
      items: order.items.map((item) => ({
        name: item.productName,
        variant: item.variantLabel,
        quantity: item.quantity,
      })),
      carrier: order.carrier,
      tracking_number: order.trackingNumber,
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
  orders: CustomerOrderSummary[];
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

  return `BUSINESS CONTEXT (answer ONLY from this, the catalog, and customer orders — never invent missing fields):
- Business name: ${configuredOrNot(input.business.name)}
- AI tone: ${input.business.aiTone}
- Returns policy: ${configuredOrNot(input.business.returnsPolicyText)}
- Dispatch days: ${dispatch}

ACTIVE CATALOG (product existence, price, variants, and in_stock — never invent items):
${catalogForPrompt(input.catalog)}

CUSTOMER ORDERS (this buyer's recent non-cancelled orders — the only source of truth for status/tracking):
${ordersForPrompt(input.orders)}

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
  const returnRef =
    typeof record.return_order_ref === "string" && record.return_order_ref.trim()
      ? record.return_order_ref.trim()
      : null;
  const reason =
    typeof record.return_reason === "string" && record.return_reason.trim()
      ? record.return_reason.trim()
      : null;
  const detail =
    typeof record.return_reason_detail === "string" &&
    record.return_reason_detail.trim()
      ? record.return_reason_detail.trim()
      : null;

  return {
    reply,
    escalate_to_seller: escalate,
    is_return_request: record.is_return_request === true,
    needs_order_clarification: record.needs_order_clarification === true,
    return_order_ref: returnRef,
    return_reason: reason,
    return_reason_detail: detail,
  };
}
