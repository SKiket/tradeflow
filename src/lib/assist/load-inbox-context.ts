import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchRecentCustomerOrders } from "@/lib/orders/customer-orders";
import { fetchActiveCatalog } from "@/lib/products/catalog";
import type { GuardrailProduct } from "@/lib/support/reply-guardrail";

export type InboxAssistContext = {
  customerLanguage: string | null;
  customerFirstName: string | null;
  sellerNeeded: boolean;
  shopFaq: { question: string; answer: string }[];
  deliveryInfo: string | null;
  catalogSummary: string;
  ordersSummary: string;
  recentMessages: string;
  products: GuardrailProduct[];
  contextBlob: string;
};

export async function loadInboxAssistContext(params: {
  supabase: SupabaseClient;
  businessId: string;
  threadId: string;
  customerId: string;
}): Promise<InboxAssistContext> {
  const { supabase, businessId, threadId, customerId } = params;

  const [businessRes, customerRes, messagesRes, catalog, orders] =
    await Promise.all([
      supabase
        .from("businesses")
        .select("shop_faq, delivery_info, name")
        .eq("id", businessId)
        .maybeSingle(),
      supabase
        .from("customers")
        .select("preferred_language, name")
        .eq("id", customerId)
        .eq("business_id", businessId)
        .maybeSingle(),
      supabase
        .from("messages")
        .select("direction, normalised_text, ai_parse_result, created_at")
        .eq("business_id", businessId)
        .eq("thread_id", threadId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(12),
      fetchActiveCatalog(supabase, businessId),
      fetchRecentCustomerOrders(supabase, {
        businessId,
        customerId,
        limit: 10,
      }),
    ]);

  const shopFaqRaw = Array.isArray(businessRes.data?.shop_faq)
    ? businessRes.data!.shop_faq
    : [];
  const shopFaq = shopFaqRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const rec = item as Record<string, unknown>;
      const question =
        typeof rec.question === "string" ? rec.question.trim() : "";
      const answer = typeof rec.answer === "string" ? rec.answer.trim() : "";
      if (!question || !answer) return null;
      return { question, answer };
    })
    .filter((item): item is { question: string; answer: string } =>
      Boolean(item),
    );

  const deliveryInfo =
    typeof businessRes.data?.delivery_info === "string"
      ? businessRes.data.delivery_info.trim() || null
      : null;

  const customerLanguage =
    typeof customerRes.data?.preferred_language === "string"
      ? customerRes.data.preferred_language
      : null;
  const rawName =
    typeof customerRes.data?.name === "string"
      ? customerRes.data.name.trim()
      : "";
  // First name only — no phone/email.
  const customerFirstName = rawName
    ? rawName.split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "") || null
    : null;

  const messages = ((messagesRes.data ?? []) as Array<{
    direction: string;
    normalised_text: string | null;
    ai_parse_result: unknown;
  }>).reverse();

  let sellerNeeded = false;
  for (const msg of messages) {
    const parse = msg.ai_parse_result;
    if (parse && typeof parse === "object") {
      const row = parse as Record<string, unknown>;
      if (row.escalate_to_seller === true) sellerNeeded = true;
      if (row.skipped === true && row.reason === "ai_paused") sellerNeeded = true;
    }
  }

  const catalogSummary =
    catalog.length === 0
      ? "(no active products)"
      : JSON.stringify(
          catalog.map((p) => ({
            id: p.id,
            name: p.name,
            price_pence: p.price_pence,
            description: p.description,
            variants: p.variants.map((v) => ({
              label: v.label,
              in_stock: !v.track_inventory || (v.available ?? 0) > 0,
            })),
          })),
        );

  const ordersSummary =
    orders.length === 0
      ? "(no open orders)"
      : JSON.stringify(
          orders.map((o) => ({
            order_ref: o.orderRef,
            status: o.status,
            items: o.items.map((i) => ({
              name: i.productName,
              variant: i.variantLabel,
              quantity: i.quantity,
            })),
          })),
        );

  const recentMessages = messages
    .map(
      (m) =>
        `[${m.direction}] ${(m.normalised_text ?? "").slice(0, 400)}`,
    )
    .join("\n");

  const products: GuardrailProduct[] = catalog.map((p) => ({
    id: p.id,
    name: p.name,
    ingredients: p.ingredients,
    allergens_status: p.allergens_status,
    allergens_text: p.allergens_text,
    usage_instructions: p.usage_instructions,
    storage_and_care: p.storage_and_care,
    size_and_fit: p.size_and_fit,
  }));

  const contextBlob = [
    `Shop: ${businessRes.data?.name ?? ""}`,
    `Delivery: ${deliveryInfo ?? "(not configured)"}`,
    `FAQ: ${JSON.stringify(shopFaq)}`,
    `Catalog: ${catalogSummary}`,
    `Orders: ${ordersSummary}`,
  ].join("\n");

  return {
    customerLanguage,
    customerFirstName,
    sellerNeeded,
    shopFaq,
    deliveryInfo,
    catalogSummary,
    ordersSummary,
    recentMessages,
    products,
    contextBlob,
  };
}
