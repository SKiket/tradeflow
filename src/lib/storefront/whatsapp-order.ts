/**
 * Pre-filled WhatsApp text for a catalog item. Wording is deliberate: product
 * + variant by name so inbound order_parse can match the live catalog.
 */
export function storefrontOrderMessage(
  productName: string,
  variantLabel?: string | null,
): string {
  const name = productName.trim();
  const label = variantLabel?.trim();
  if (label) {
    return `Hi! I'd like to order the ${name} (${label})`;
  }
  return `Hi! I'd like to order the ${name}`;
}

/**
 * wa.me requires the number as digits only (no + / spaces). `text` must be
 * URI-encoded so names with spaces and parentheses survive the redirect.
 */
export function waMeOrderUrl(phoneE164: string, message: string): string {
  const digits = phoneE164.replace(/[^\d]/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
