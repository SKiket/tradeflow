import { cache } from "react";

import { createAdminClient } from "@/lib/supabase/admin";

import { storefrontOrderMessage, waMeOrderUrl } from "./whatsapp-order";

const SLUG_RE = /^[a-z0-9-]+$/;

export type PublicStorefrontVariant = {
  id: string;
  label: string | null;
  orderUrl: string | null;
};

export type PublicStorefrontProduct = {
  name: string;
  description: string | null;
  pricePence: number;
  photoUrl: string | null;
  variants: PublicStorefrontVariant[];
};

export type PublicStorefront = {
  businessId: string;
  slug: string;
  name: string;
  bio: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  acceptingOrders: boolean;
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
};

/**
 * Public catalog for a storefront slug.
 *
 * Uses the service-role client (RLS is not loosened). Exposes `businessId`
 * and variant ids so the cart can check out; never owner, Stripe, dispatch,
 * WhatsApp credentials, or product-row ids.
 */
export const fetchPublicStorefront = cache(
  async (slug: string): Promise<PublicStorefront | null> => {
    const trimmed = slug.trim();
    if (!SLUG_RE.test(trimmed)) return null;

    const supabase = createAdminClient();
    const { data: business, error: businessError } = await supabase
      .from("businesses")
      .select("id, name, bio, logo_url, banner_url, whatsapp_phone_e164")
      .eq("slug", trimmed)
      .is("deleted_at", null)
      .maybeSingle();

    if (businessError) {
      throw new Error(
        `storefront business lookup failed: ${businessError.message}`,
      );
    }
    if (!business) return null;

    const phone =
      (business.whatsapp_phone_e164 as string | null)?.trim() || null;

    const { data: productRows, error: productError } = await supabase
      .from("products")
      .select(
        "name, description, price_pence, photo_url, product_variants(id, label, deleted_at)",
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
          };
        });
      if (variants.length === 0) continue;
      products.push({
        name,
        description: (row.description as string | null) ?? null,
        pricePence: row.price_pence as number,
        photoUrl: (row.photo_url as string | null) ?? null,
        variants,
      });
    }

    return {
      businessId: business.id as string,
      slug: trimmed,
      name: business.name as string,
      bio: (business.bio as string | null) ?? null,
      logoUrl: (business.logo_url as string | null) ?? null,
      bannerUrl: (business.banner_url as string | null) ?? null,
      acceptingOrders: Boolean(phone),
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
