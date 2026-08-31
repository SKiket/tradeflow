import { cache } from "react";

import { createAdminClient } from "@/lib/supabase/admin";

import { storefrontOrderMessage, waMeOrderUrl } from "./whatsapp-order";

const SLUG_RE = /^[a-z0-9-]+$/;

export type PublicStorefrontVariant = {
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
  name: string;
  bio: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  acceptingOrders: boolean;
  products: PublicStorefrontProduct[];
};

type VariantRow = {
  label: string | null;
  deleted_at: string | null;
};

/**
 * Public catalog for a storefront slug.
 *
 * Uses the service-role client (RLS is not loosened). Selects only
 * storefront-safe columns — never owner, Stripe, dispatch, or internal ids
 * in the returned payload. `businesses.id` and `whatsapp_phone_e164` are
 * read server-side to join products and build wa.me links, then dropped.
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
        "name, description, price_pence, photo_url, product_variants(label, deleted_at)",
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
      const variants = (
        (row.product_variants as VariantRow[] | null) ?? []
      )
        .filter((variant) => !variant.deleted_at)
        .map((variant) => {
          const label = variant.label ?? null;
          const message = storefrontOrderMessage(name, label);
          return {
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
      name: business.name as string,
      bio: (business.bio as string | null) ?? null,
      logoUrl: (business.logo_url as string | null) ?? null,
      bannerUrl: (business.banner_url as string | null) ?? null,
      acceptingOrders: Boolean(phone),
      products,
    };
  },
);
