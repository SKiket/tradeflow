import type { SupabaseClient } from "@supabase/supabase-js";

import { productUrl, shopUrl } from "@/lib/storefront/url";

/** Shop + active product deep-links for this business (URL allowlist). */
export async function loadAllowedShopUrls(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string[]> {
  const { data: business } = await supabase
    .from("businesses")
    .select("slug")
    .eq("id", businessId)
    .maybeSingle();
  const slug = (business?.slug as string | null)?.trim();
  if (!slug) return [];

  const urls = [
    shopUrl({ slug }),
    shopUrl({ slug }, { src: "wa" }),
    shopUrl({ slug }, { src: "link" }),
    shopUrl({ slug }, { src: "qr" }),
    shopUrl({ slug }, { src: "social" }),
  ];

  const { data: products } = await supabase
    .from("products")
    .select("id")
    .eq("business_id", businessId)
    .eq("active", true)
    .is("deleted_at", null)
    .limit(200);

  for (const row of products ?? []) {
    const id = row.id as string;
    urls.push(productUrl({ slug }, { id }));
    urls.push(productUrl({ slug }, { id }, { src: "wa" }));
  }
  return urls;
}
