const PRODUCTION_ORIGIN = "https://tradeflow-tau-blush.vercel.app";

/** Single public origin for storefront / tracking / OG — change custom domain here. */
export function publicAppOrigin(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return PRODUCTION_ORIGIN;
}

export type ShopUrlBusiness = { slug: string };
export type ProductUrlProduct = { id: string };

/**
 * Public shop URL. Pass src: "wa" only for WhatsApp-shared links (attribution).
 * Never put personal data in the query string.
 */
export function shopUrl(
  business: ShopUrlBusiness,
  options?: { src?: "wa" },
): string {
  const slug = business.slug.trim();
  const base = `${publicAppOrigin()}/s/${encodeURIComponent(slug)}`;
  return options?.src === "wa" ? `${base}?src=wa` : base;
}

/**
 * Public product deep-link. Same src rules as shopUrl.
 */
export function productUrl(
  business: ShopUrlBusiness,
  product: ProductUrlProduct,
  options?: { src?: "wa" },
): string {
  const slug = business.slug.trim();
  const id = product.id.trim();
  const base = `${publicAppOrigin()}/s/${encodeURIComponent(slug)}/p/${encodeURIComponent(id)}`;
  return options?.src === "wa" ? `${base}?src=wa` : base;
}

/** @deprecated Prefer shopUrl({ slug }) — kept for settings display. */
export function storefrontUrl(slug: string): string {
  return shopUrl({ slug });
}

export function orderTrackingUrl(orderRef: string): string {
  return `${publicAppOrigin()}/t/${encodeURIComponent(orderRef)}`;
}
