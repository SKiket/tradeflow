/**
 * Multi-item WhatsApp cart deep-link builder (Step 23).
 * Pure functions — safe for client + server. No prices, no personal data.
 */

export const WHATSAPP_CART_MAX_LINES = 15;
/** Safe ceiling for wa.me URLs (browser / WhatsApp clients). */
export const WHATSAPP_CART_MAX_URL_CHARS = 1500;
const MAX_NAME_CHARS = 80;

export type WhatsAppCartLine = {
  productName: string;
  variantLabel?: string | null;
  quantity: number;
};

export type WhatsAppCartBuildOk = {
  ok: true;
  message: string;
  url: string;
};

export type WhatsAppCartBuildFail = {
  ok: false;
  reason: "no_phone" | "empty_cart" | "too_many_lines" | "url_too_long";
  message?: string;
};

export type WhatsAppCartBuildResult = WhatsAppCartBuildOk | WhatsAppCartBuildFail;

function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, "");
}

export function sanitizeCartName(raw: string): string {
  const cleaned = stripControlChars(raw).replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_NAME_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_NAME_CHARS - 1)}…`;
}

export function formatCartLineLabel(line: WhatsAppCartLine): string {
  const product = sanitizeCartName(line.productName);
  const variant = line.variantLabel
    ? sanitizeCartName(line.variantLabel)
    : "";
  if (variant && variant.toLowerCase() !== "standard") {
    return `${product} (${variant})`;
  }
  return product;
}

/**
 * Prefill text in the storefront browsing language (EN or FR).
 */
export function buildWhatsAppCartMessage(
  lines: WhatsAppCartLine[],
  lang: "en" | "fr" = "en",
): string {
  const parts = lines
    .filter((l) => l.quantity > 0 && sanitizeCartName(l.productName))
    .map((l) => `${Math.floor(l.quantity)} × ${formatCartLineLabel(l)}`);
  if (lang === "fr") {
    return `Bonjour, je voudrais commander : ${parts.join(", ")}`;
  }
  return `Hello, I would like to order: ${parts.join(", ")}`;
}

/** Digits-only for wa.me, or extract from an existing wa.me / api.whatsapp.com link. */
export function whatsappDigitsFromPhoneOrLink(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fromLink = trimmed.match(
    /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?\d+)/i,
  );
  const source = fromLink?.[1] ?? trimmed;
  const digits = source.replace(/[^\d]/g, "");
  return digits.length >= 8 ? digits : null;
}

export function buildWhatsAppCartLink(params: {
  phoneOrLink: string;
  lines: WhatsAppCartLine[];
  lang?: "en" | "fr";
  /** Override default ~1500 char safety ceiling (tests). */
  maxUrlChars?: number;
}): WhatsAppCartBuildResult {
  const digits = whatsappDigitsFromPhoneOrLink(params.phoneOrLink);
  if (!digits) return { ok: false, reason: "no_phone" };

  const usable = params.lines.filter(
    (l) => Math.floor(l.quantity) > 0 && sanitizeCartName(l.productName),
  );
  if (usable.length === 0) return { ok: false, reason: "empty_cart" };
  if (usable.length > WHATSAPP_CART_MAX_LINES) {
    return { ok: false, reason: "too_many_lines" };
  }

  const message = buildWhatsAppCartMessage(usable, params.lang ?? "en");
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  const maxChars = params.maxUrlChars ?? WHATSAPP_CART_MAX_URL_CHARS;
  if (url.length > maxChars) {
    return { ok: false, reason: "url_too_long", message };
  }
  return { ok: true, message, url };
}

/** Kept for single-item product pages. */
export function storefrontOrderMessage(
  productName: string,
  variantLabel?: string | null,
): string {
  const name = sanitizeCartName(productName);
  const label = variantLabel ? sanitizeCartName(variantLabel) : "";
  if (label) {
    return `Hi! I'd like to order the ${name} (${label})`;
  }
  return `Hi! I'd like to order the ${name}`;
}

export function waMeOrderUrl(phoneE164: string, message: string): string {
  const digits = whatsappDigitsFromPhoneOrLink(phoneE164) ?? "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
