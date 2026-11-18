const PRODUCTION_ORIGIN = "https://tradeflow-tau-blush.vercel.app";

/** Single public origin for storefront / tracking / OG — change custom domain here. */
export function publicAppOrigin(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return PRODUCTION_ORIGIN;
}

/** Harmless placement tags only — never personal data. */
export type ShopLinkSrc = "wa" | "link" | "qr" | "social";

export type ShopUrlBusiness = { slug: string };
export type ProductUrlProduct = { id: string };

const SRC_VALUES: readonly ShopLinkSrc[] = ["wa", "link", "qr", "social"];

export function isShopLinkSrc(value: unknown): value is ShopLinkSrc {
  return typeof value === "string" && (SRC_VALUES as readonly string[]).includes(value);
}

function withSrc(base: string, src?: ShopLinkSrc): string {
  if (!src) return base;
  return `${base}?src=${encodeURIComponent(src)}`;
}

/**
 * Public shop URL. Optional src is a placement tag only (link/qr/social/wa).
 * Never put personal data in the query string.
 */
export function shopUrl(
  business: ShopUrlBusiness,
  options?: { src?: ShopLinkSrc },
): string {
  const slug = business.slug.trim();
  const base = `${publicAppOrigin()}/s/${encodeURIComponent(slug)}`;
  return withSrc(base, options?.src);
}

/**
 * Public product deep-link. Same src rules as shopUrl.
 */
export function productUrl(
  business: ShopUrlBusiness,
  product: ProductUrlProduct,
  options?: { src?: ShopLinkSrc },
): string {
  const slug = business.slug.trim();
  const id = product.id.trim();
  const base = `${publicAppOrigin()}/s/${encodeURIComponent(slug)}/p/${encodeURIComponent(id)}`;
  return withSrc(base, options?.src);
}

/** @deprecated Prefer shopUrl({ slug }) — kept for settings display. */
export function storefrontUrl(slug: string): string {
  return shopUrl({ slug });
}

export function orderTrackingUrl(orderRef: string): string {
  return `${publicAppOrigin()}/t/${encodeURIComponent(orderRef)}`;
}
