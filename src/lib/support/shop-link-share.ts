/**
 * Step 24g — shop / product link sharing for WhatsApp replies.
 * The model never writes URLs; the server appends a fixed EN/FR line.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { t } from "@/lib/i18n";
import type { SupportedLang } from "@/lib/i18n/types";
import { canAcceptOrders } from "@/lib/stripe/billing-gate";
import { productUrl, shopUrl } from "@/lib/storefront/url";
import { createAdminClient } from "@/lib/supabase/admin";

export type ShopLinkMode = "off" | "ask" | "ask_and_suggest";
export type ShareLinkKind = "none" | "shop" | "product";

export type AiShareLinkIntent = {
  share_link: ShareLinkKind;
  share_product_id: string | null;
};

const EXPLICIT_SHOP_LINK_RE =
  /\b(website|web\s*site|online\s*shop|webshop|shop\s*link|catalogue|catalog|menu|price\s*list|pricelist|photo(?:s)?|see\s+everything|what\s+do\s+you\s+sell|show\s+me\s+(?:the\s+)?(?:shop|store|catalogue|catalog|menu)|send\s+(?:me\s+)?(?:the\s+)?(?:link|website)|your\s+(?:site|website|shop|store)|lien|site\s*web|boutique\s+en\s+ligne|catalogue|menu|liste\s+de\s+prix|photos?|voir\s+tout|qu['’]?\s*est[- ]ce\s+que\s+vous\s+vendez|envoyez[- ]moi\s+(?:le\s+)?lien|votre\s+(?:site|boutique))\b/iu;

const GREETING_RE =
  /^(?:hi|hello|hey|hiya|good\s+(?:morning|afternoon|evening)|bonjour|salut|coucou|bonsoir|allo|allô)(?:\s*[!.]*)?$/iu;

const OPT_OUT_RE =
  /\b(stop|unsubscribe|no\s+thanks|no\s+thank\s+you|don['’]?t\s+send|do\s+not\s+send|non\s+merci|arr[eê]te(?:z)?|ne\s+(?:m['’])?envoyez\s+pas|d[eé]sabonne(?:r|z)?)\b/iu;

const COMPLAINT_RE =
  /\b(complaint|complain|refund|return|dispute|chargeback|scam|ripoff|rip[\s-]?off|damaged|broken|wrong\s+item|missing\s+item|r[eé]clamation|remboursement|litige|retour|cass[eé]|endommag[eé]|article\s+manqu(?:e|ant)|mauvais\s+article)\b/iu;

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"')\]]+/gi;

const SUGGESTED_WINDOW_MS = 24 * 60 * 60 * 1000;

export function parseShopLinkMode(value: unknown): ShopLinkMode {
  if (value === "off" || value === "ask" || value === "ask_and_suggest") {
    return value;
  }
  return "ask_and_suggest";
}

export function detectExplicitShopLinkRequest(text: string): boolean {
  return EXPLICIT_SHOP_LINK_RE.test((text || "").trim());
}

export function detectGreeting(text: string): boolean {
  return GREETING_RE.test((text || "").trim());
}

export function detectLinkOptOut(text: string): boolean {
  return OPT_OUT_RE.test((text || "").trim());
}

export function detectComplaintTopic(text: string): boolean {
  return COMPLAINT_RE.test((text || "").trim());
}

/**
 * Remove any http(s) URL that is not exactly one of the allowed generated links.
 */
export function stripInventedUrls(
  text: string,
  allowedUrls: readonly string[] = [],
): string {
  const allowed = new Set(allowedUrls.filter(Boolean));
  return (text || "")
    .replace(URL_IN_TEXT_RE, (match) => {
      const cleaned = match.replace(/[.,;:!?)]+$/, "");
      const trailing = match.slice(cleaned.length);
      if (allowed.has(cleaned) || allowed.has(match)) return match;
      return trailing;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function shopLinkLine(lang: string, url: string): string {
  return t("support.shop_link_line", lang as SupportedLang, { url });
}

export function productLinkLine(lang: string, url: string): string {
  return t("support.product_link_line", lang as SupportedLang, { url });
}

export function shopLinkOffReply(lang: string): string {
  return t("support.shop_link_off", lang as SupportedLang);
}

export type ShopLinkShareDecision = {
  kind: ShareLinkKind;
  url: string | null;
  productId: string | null;
  /** Why nothing was shared (for logs / tests). */
  skipReason:
    | null
    | "off"
    | "off_explicit_neutral"
    | "not_live"
    | "opt_out"
    | "complaint"
    | "open_draft"
    | "suggested_cooldown"
    | "mode_ask_only"
    | "no_intent"
    | "product_not_found";
  /** When mode is off and the buyer explicitly asked — use fixed neutral copy. */
  useOffNeutral: boolean;
};

export type ResolveShopLinkShareParams = {
  businessId: string;
  threadId: string;
  customerId: string;
  messageText: string;
  lang: string;
  mode: ShopLinkMode;
  /** From AI — never trusted for the URL itself. */
  aiShare: AiShareLinkIntent;
  /** Suggested triggers from the caller (greeting / unmatched / out of stock). */
  suggestReason?: "greeting" | "unmatched" | "out_of_stock" | null;
  /** Hard blocks from caller (return flow, payment complaint, etc.). */
  forceBlock?: boolean;
  supabase?: SupabaseClient;
};

export async function resolveShopLinkShare(
  params: ResolveShopLinkShareParams,
): Promise<ShopLinkShareDecision> {
  const supabase = params.supabase ?? createAdminClient();
  const empty = (
    skipReason: ShopLinkShareDecision["skipReason"],
    useOffNeutral = false,
  ): ShopLinkShareDecision => ({
    kind: "none",
    url: null,
    productId: null,
    skipReason,
    useOffNeutral,
  });

  const explicit = detectExplicitShopLinkRequest(params.messageText);
  if (params.mode === "off") {
    return empty(explicit ? "off_explicit_neutral" : "off", explicit);
  }

  if (detectLinkOptOut(params.messageText)) return empty("opt_out");

  // Explicit catalogue/website asks always share (when live). Complaints and
  // forceBlock only suppress suggested / non-explicit shares.
  const complaintLike =
    params.forceBlock || detectComplaintTopic(params.messageText);
  if (!explicit && complaintLike && params.aiShare.share_link === "none") {
    return empty("complaint");
  }

  const live = await loadLiveShop(supabase, params.businessId);
  if (!live) return empty("not_live");

  // Product intent (explicit product ask from AI or name match left to caller).
  let want: ShareLinkKind = "none";
  let productId: string | null = null;

  if (explicit) {
    want = "shop";
  } else if (
    params.aiShare.share_link === "product" &&
    params.aiShare.share_product_id
  ) {
    want = "product";
    productId = params.aiShare.share_product_id;
  } else if (params.aiShare.share_link === "shop") {
    want = "shop";
  } else if (params.suggestReason && params.mode === "ask_and_suggest") {
    want = "shop";
  } else if (params.suggestReason && params.mode === "ask") {
    return empty("mode_ask_only");
  } else {
    return empty("no_intent");
  }

  // Suggested-only limits (explicit / AI product always share when live).
  const isSuggested =
    !explicit &&
    params.aiShare.share_link === "none" &&
    Boolean(params.suggestReason);

  if (isSuggested) {
    if (await hasOpenOrderDraftOrPayment(supabase, {
      businessId: params.businessId,
      threadId: params.threadId,
      customerId: params.customerId,
    })) {
      return empty("open_draft");
    }
    if (
      await sharedSuggestedLinkRecently(supabase, {
        businessId: params.businessId,
        threadId: params.threadId,
      })
    ) {
      return empty("suggested_cooldown");
    }
  }

  if (want === "product" && productId) {
    const ok = live.activeProductIds.has(productId);
    if (!ok) {
      // Fall back to shop when product id is stale / inactive.
      want = "shop";
      productId = null;
    }
  }

  if (want === "product" && productId) {
    return {
      kind: "product",
      url: productUrl({ slug: live.slug }, { id: productId }, { src: "wa" }),
      productId,
      skipReason: null,
      useOffNeutral: false,
    };
  }

  if (want === "shop") {
    return {
      kind: "shop",
      url: shopUrl({ slug: live.slug }, { src: "wa" }),
      productId: null,
      skipReason: null,
      useOffNeutral: false,
    };
  }

  return empty("no_intent");
}

/**
 * Apply decision to a reply: strip invented URLs, optionally replace with
 * off-neutral, append fixed link line.
 */
export function applyShopLinkToReply(params: {
  reply: string;
  decision: ShopLinkShareDecision;
  lang: string;
}): { reply: string; sharedUrl: string | null } {
  if (params.decision.useOffNeutral) {
    return { reply: shopLinkOffReply(params.lang), sharedUrl: null };
  }

  const allowed = params.decision.url ? [params.decision.url] : [];
  let reply = stripInventedUrls(params.reply, allowed);

  if (params.decision.url && params.decision.kind !== "none") {
    const line =
      params.decision.kind === "product"
        ? productLinkLine(params.lang, params.decision.url)
        : shopLinkLine(params.lang, params.decision.url);
    if (!reply.includes(params.decision.url)) {
      reply = reply.trim() ? `${reply.trim()}\n\n${line}` : line;
    }
  }

  return { reply, sharedUrl: params.decision.url };
}

type LiveShop = {
  slug: string;
  activeProductIds: Set<string>;
};

async function loadLiveShop(
  supabase: SupabaseClient,
  businessId: string,
): Promise<LiveShop | null> {
  const { data: business, error } = await supabase
    .from("businesses")
    .select(
      "slug, closed_at, purge_after, stripe_subscription_status, dispute_balance_hold, deleted_at",
    )
    .eq("id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !business) return null;
  if (business.closed_at || business.purge_after) return null;
  if (
    !canAcceptOrders({
      stripe_subscription_status:
        (business.stripe_subscription_status as string | null) ?? null,
      closed_at: (business.closed_at as string | null) ?? null,
      dispute_balance_hold:
        (business.dispute_balance_hold as boolean | null) ?? false,
    })
  ) {
    return null;
  }

  const { data: products, error: productError } = await supabase
    .from("products")
    .select("id")
    .eq("business_id", businessId)
    .eq("active", true)
    .is("deleted_at", null)
    .limit(200);

  if (productError) return null;
  const ids = (products ?? [])
    .map((row) => row.id as string)
    .filter(Boolean);
  if (ids.length === 0) return null;

  return {
    slug: business.slug as string,
    activeProductIds: new Set(ids),
  };
}

async function hasOpenOrderDraftOrPayment(
  supabase: SupabaseClient,
  params: { businessId: string; threadId: string; customerId: string },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("orders")
    .select("id")
    .eq("business_id", params.businessId)
    .eq("customer_id", params.customerId)
    .in("status", ["PENDING_CONFIRMATION", "AWAITING_PAYMENT"])
    .is("deleted_at", null)
    .limit(1);

  if (error) {
    console.error("[shop-link] open draft lookup failed", error.message);
    return true; // fail closed for suggested
  }
  return (data?.length ?? 0) > 0;
}

async function sharedSuggestedLinkRecently(
  supabase: SupabaseClient,
  params: { businessId: string; threadId: string },
): Promise<boolean> {
  const since = new Date(Date.now() - SUGGESTED_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select("id, normalised_text")
    .eq("business_id", params.businessId)
    .eq("thread_id", params.threadId)
    .eq("direction", "outbound")
    .is("deleted_at", null)
    .gte("created_at", since)
    .limit(40);

  if (error) {
    console.error("[shop-link] cooldown lookup failed", error.message);
    return true;
  }

  // Count only server-appended link lines (suggested or prior share).
  // Matching the fixed EN/FR templates avoids unrelated URL noise.
  return (data ?? []).some((row) => {
    if (typeof row.normalised_text !== "string") return false;
    const text = row.normalised_text;
    return (
      text.includes("?src=wa") &&
      (/here's our shop:/i.test(text) ||
        /here's the product:/i.test(text) ||
        /voici notre boutique/i.test(text) ||
        /voici le produit/i.test(text))
    );
  });
}

/** Test helpers. */
export const __shopLinkPatterns = {
  EXPLICIT_SHOP_LINK_RE,
  GREETING_RE,
  OPT_OUT_RE,
  COMPLAINT_RE,
  URL_IN_TEXT_RE,
};
