import { cache } from "react";

import { parseAccentHex } from "@/lib/brand/accent";
import { availableQuantity, isVariantLowStock } from "@/lib/products/stock";
import { canAcceptOrders } from "@/lib/stripe/billing-gate";
import { createAdminClient } from "@/lib/supabase/admin";

import { storefrontOrderMessage, waMeOrderUrl } from "./whatsapp-order";

const SLUG_RE = /^[a-z0-9-]+$/;

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export type PublicStorefrontVariant = {
  id: string;
  label: string | null;
  orderUrl: string | null;
  /** Null when inventory is not tracked — no badge in that case. */
  stockStatus: StockStatus | null;
};

export type PublicStorefrontFaq = { question: string; answer: string };

export type PublicStorefrontProduct = {
  name: string;
  description: string | null;
  pricePence: number;
  photoUrl: string | null;
  /** Ordered gallery. Storefront cards only carousel when this has 2+ URLs. */
  imageUrls: string[];
  usageInstructions: string | null;
  ingredients: string | null;
  storageAndCare: string | null;
  sizeAndFit: string | null;
  allergensStatus: "not_provided" | "none_declared" | "listed";
  allergensText: string | null;
  faqs: PublicStorefrontFaq[];
  variants: PublicStorefrontVariant[];
};

export type PublicStorefront = {
  businessId: string;
  slug: string;
  name: string;
  bio: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** Raw DB value; null means the TradeFlow amber default. */
  accentColor: string | null;
  acceptingOrders: boolean;
  /** Shop WhatsApp E.164 when configured (for cart deep-links). */
  whatsappPhoneE164: string | null;
  /** False when TradeFlow billing is not trialing/active — shop exists, catalog hidden. */
  takingOrders: boolean;
  /** True when the seller closed the shop (grace or pending purge). */
  shopClosed: boolean;
  /** True when the seller has written a returns policy — never the policy text itself. */
  hasReturnsPolicy: boolean;
  deliveryInfo: string | null;
  shopFaq: PublicStorefrontFaq[];
  products: PublicStorefrontProduct[];
};

export type CatalogLine = {
  variantId: string;
  productName: string;
  variantLabel: string | null;
  pricePence: number;
};

type VariantRow = {
  id: string;
  label: string | null;
  deleted_at: string | null;
  track_inventory: boolean | null;
  stock_quantity: number | null;
  reserved_quantity: number | null;
  low_stock_threshold: number | null;
};

function variantStockStatus(variant: VariantRow): StockStatus | null {
  if (!variant.track_inventory) return null;
  const available = availableQuantity(
    variant.stock_quantity,
    variant.reserved_quantity,
  );
  if (available <= 0) return "out_of_stock";
  if (isVariantLowStock(variant)) return "low_stock";
  return "in_stock";
}

/**
 * Public catalog for a storefront slug.
 *
 * Uses the service-role client (RLS is not loosened). Exposes `businessId`
 * and variant ids so the cart can check out; never owner, Stripe, dispatch,
 * WhatsApp credentials, product-row ids, or the returns policy body.
 */
export const fetchPublicStorefront = cache(
  async (slug: string): Promise<PublicStorefront | null> => {
    const trimmed = slug.trim();
    if (!SLUG_RE.test(trimmed)) return null;

    const supabase = createAdminClient();
    const { data: business, error: businessError } = await supabase
      .from("businesses")
      .select(
        "id, name, bio, logo_url, banner_url, storefront_accent_color, whatsapp_phone_e164, returns_policy_text, shop_faq, delivery_info, stripe_subscription_status, closed_at, dispute_balance_hold",
      )
      .eq("slug", trimmed)
      .is("deleted_at", null)
      .maybeSingle();

    if (businessError) {
      throw new Error(
        `storefront business lookup failed: ${businessError.message}`,
      );
    }
    if (!business) return null;

    const shopClosed = Boolean(business.closed_at);
    const phone =
      (business.whatsapp_phone_e164 as string | null)?.trim() || null;

    // Closed shops: no catalogue — only the closed page.
    if (shopClosed) {
      return {
        businessId: business.id as string,
        slug: trimmed,
        name: business.name as string,
        bio: null,
        logoUrl: (business.logo_url as string | null) ?? null,
        bannerUrl: null,
        accentColor: parseAccentHex(business.storefront_accent_color),
        acceptingOrders: false,
        whatsappPhoneE164: null,
        takingOrders: false,
        shopClosed: true,
        hasReturnsPolicy: false,
        deliveryInfo: null,
        shopFaq: [],
        products: [],
      };
    }

    const { data: productRows, error: productError } = await supabase
      .from("products")
      .select(
        "name, description, price_pence, photo_url, usage_instructions, ingredients, storage_and_care, size_and_fit, allergens_status, allergens_text, product_faqs, product_images(image_url, sort_order), product_variants(id, label, deleted_at, track_inventory, stock_quantity, reserved_quantity, low_stock_threshold)",
      )
      .eq("business_id", business.id)
      .eq("active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true });

    if (productError) {
      throw new Error(
        `storefront catalog lookup failed: ${productError.message}`,
      );
    }

    const products: PublicStorefrontProduct[] = [];
    for (const row of productRows ?? []) {
      const name = row.name as string;
      const variants = ((row.product_variants as VariantRow[] | null) ?? [])
        .filter((variant) => !variant.deleted_at)
        .map((variant) => {
          const label = variant.label ?? null;
          const message = storefrontOrderMessage(name, label);
          return {
            id: variant.id,
            label,
            orderUrl: phone ? waMeOrderUrl(phone, message) : null,
            stockStatus: variantStockStatus(variant),
          };
        });
      if (variants.length === 0) continue;
      const gallery = (
        (row.product_images as
          | { image_url: string; sort_order: number }[]
          | null) ?? []
      )
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((image) => image.image_url)
        .filter((url) => Boolean(url?.trim()));
      const statusRaw = (row.allergens_status as string | null) ?? "not_provided";
      const allergensStatus =
        statusRaw === "listed" || statusRaw === "none_declared"
          ? statusRaw
          : "not_provided";
      const faqsRaw = Array.isArray(row.product_faqs) ? row.product_faqs : [];
      const faqs = faqsRaw
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const rec = item as Record<string, unknown>;
          const q = typeof rec.question === "string" ? rec.question.trim() : "";
          const a = typeof rec.answer === "string" ? rec.answer.trim() : "";
          if (!q || !a) return null;
          return { question: q, answer: a };
        })
        .filter((item): item is PublicStorefrontFaq => Boolean(item));
      products.push({
        name,
        description: (row.description as string | null) ?? null,
        pricePence: row.price_pence as number,
        photoUrl: (row.photo_url as string | null) ?? null,
        imageUrls: gallery,
        usageInstructions: (row.usage_instructions as string | null) ?? null,
        ingredients: (row.ingredients as string | null) ?? null,
        storageAndCare: (row.storage_and_care as string | null) ?? null,
        sizeAndFit: (row.size_and_fit as string | null) ?? null,
        allergensStatus,
        allergensText:
          allergensStatus === "listed"
            ? ((row.allergens_text as string | null) ?? null)
            : null,
        faqs,
        variants,
      });
    }

    const shopFaqRaw = Array.isArray(business.shop_faq)
      ? business.shop_faq
      : [];
    const shopFaq = shopFaqRaw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const rec = item as Record<string, unknown>;
        const q = typeof rec.question === "string" ? rec.question.trim() : "";
        const a = typeof rec.answer === "string" ? rec.answer.trim() : "";
        if (!q || !a) return null;
        return { question: q, answer: a };
      })
      .filter((item): item is PublicStorefrontFaq => Boolean(item));

    return {
      businessId: business.id as string,
      slug: trimmed,
      name: business.name as string,
      bio: (business.bio as string | null) ?? null,
      logoUrl: (business.logo_url as string | null) ?? null,
      bannerUrl: (business.banner_url as string | null) ?? null,
      accentColor: parseAccentHex(business.storefront_accent_color),
      acceptingOrders: Boolean(phone),
      whatsappPhoneE164: phone,
      takingOrders: canAcceptOrders({
        stripe_subscription_status:
          (business.stripe_subscription_status as string | null) ?? null,
        closed_at: (business.closed_at as string | null) ?? null,
        dispute_balance_hold:
          (business.dispute_balance_hold as boolean | null) ?? false,
      }),
      shopClosed: false,
      hasReturnsPolicy: Boolean(
        (business.returns_policy_text as string | null)?.trim(),
      ),
      deliveryInfo: (business.delivery_info as string | null)?.trim() || null,
      shopFaq,
      products,
    };
  },
);

export function catalogLine(
  storefront: PublicStorefront,
  variantId: string,
): CatalogLine | null {
  for (const product of storefront.products) {
    const variant = product.variants.find((entry) => entry.id === variantId);
    if (!variant) continue;
    return {
      variantId: variant.id,
      productName: product.name,
      variantLabel: variant.label,
      pricePence: product.pricePence,
    };
  }
  return null;
}

export type PublicProductPage = {
  storefront: Omit<PublicStorefront, "products">;
  product: PublicStorefrontProduct & { id: string };
};

/**
 * Single active product for a public deep-link. Returns null when the shop or
 * product is missing, inactive, closed, or not owned by the slug.
 * Product id appears only on this page (and in the URL), not on the shop listing.
 */
export const fetchPublicProduct = cache(
  async (
    slug: string,
    productId: string,
  ): Promise<PublicProductPage | null> => {
    const trimmedId = productId.trim();
    if (!trimmedId) return null;
    const storefront = await fetchPublicStorefront(slug);
    if (!storefront || storefront.shopClosed) return null;

    const supabase = createAdminClient();
    const { data: row, error } = await supabase
      .from("products")
      .select(
        "id, name, description, price_pence, photo_url, usage_instructions, ingredients, storage_and_care, size_and_fit, allergens_status, allergens_text, product_faqs, product_images(image_url, sort_order), product_variants(id, label, deleted_at, track_inventory, stock_quantity, reserved_quantity, low_stock_threshold)",
      )
      .eq("id", trimmedId)
      .eq("business_id", storefront.businessId)
      .eq("active", true)
      .is("deleted_at", null)
      .maybeSingle();

    if (error || !row) return null;

    const variants = ((row.product_variants as VariantRow[] | null) ?? [])
      .filter((variant) => !variant.deleted_at)
      .map((variant) => {
        const label = variant.label ?? null;
        const message = storefrontOrderMessage(row.name as string, label);
        return {
          id: variant.id,
          label,
          orderUrl: storefront.whatsappPhoneE164
            ? waMeOrderUrl(storefront.whatsappPhoneE164, message)
            : null,
          stockStatus: variantStockStatus(variant),
        };
      });
    if (variants.length === 0) return null;

    const gallery = (
      (row.product_images as
        | { image_url: string; sort_order: number }[]
        | null) ?? []
    )
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((image) => image.image_url)
      .filter((url) => Boolean(url?.trim()));

    const statusRaw = (row.allergens_status as string | null) ?? "not_provided";
    const allergensStatus =
      statusRaw === "listed" || statusRaw === "none_declared"
        ? statusRaw
        : "not_provided";
    const faqsRaw = Array.isArray(row.product_faqs) ? row.product_faqs : [];
    const faqs = faqsRaw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const rec = item as Record<string, unknown>;
        const q = typeof rec.question === "string" ? rec.question.trim() : "";
        const a = typeof rec.answer === "string" ? rec.answer.trim() : "";
        if (!q || !a) return null;
        return { question: q, answer: a };
      })
      .filter((item): item is PublicStorefrontFaq => Boolean(item));

    const { products: _omit, ...shop } = storefront;
    void _omit;

    return {
      storefront: shop,
      product: {
        id: row.id as string,
        name: row.name as string,
        description: (row.description as string | null) ?? null,
        pricePence: row.price_pence as number,
        photoUrl: (row.photo_url as string | null) ?? null,
        imageUrls: gallery,
        usageInstructions: (row.usage_instructions as string | null) ?? null,
        ingredients: (row.ingredients as string | null) ?? null,
        storageAndCare: (row.storage_and_care as string | null) ?? null,
        sizeAndFit: (row.size_and_fit as string | null) ?? null,
        allergensStatus,
        allergensText:
          allergensStatus === "listed"
            ? ((row.allergens_text as string | null) ?? null)
            : null,
        faqs,
        variants,
      },
    };
  },
);
