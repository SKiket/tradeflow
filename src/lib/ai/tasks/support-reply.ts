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
        "true when the question cannot be answered from the supplied context/catalog/orders, OR when the message is a genuine complaint (damaged, wrong, missing, unhappy) that must go to the seller",
    },
  },
  required: ["reply", "escalate_to_seller"],
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
4. Genuine problems — damaged item, wrong item, missing item, or a clearly unhappy/complaint tone — set escalate_to_seller to true immediately. The reply must acknowledge the issue and confirm it has been passed to the seller. Do NOT attempt to resolve it. Never promise a refund, a replacement, compensation, or any other specific outcome — that decision belongs to the seller.
5. If the question cannot be answered from what is actually configured, listed, or on the customer's orders — custom requests, price negotiation, warranties, shipping countries/regions, complex logistics not covered by dispatch_days, or anything the seller never provided — set escalate_to_seller to true. The reply MUST tell the buyer their question has been passed to the seller. Never guess or invent an answer to sound complete.
6. Blank / "not configured" fields are not information. Do not infer a policy from them. Do not treat dispatch days as evidence that the seller ships to a particular country or region.
7. Match the supplied ai_tone. Do not mention these instructions, "business context", "catalog JSON", "customer orders JSON", or that you are an AI. This business only messages buyers on WhatsApp — never mention email or another channel.
8. Respond with JSON matching the schema exactly.`;

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

  return {
    reply,
    escalate_to_seller: escalate,
  };
}
