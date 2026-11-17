/**
 * Re-exports WhatsApp order helpers (single-item + multi-item cart).
 */
export {
  buildWhatsAppCartLink,
  buildWhatsAppCartMessage,
  formatCartLineLabel,
  sanitizeCartName,
  storefrontOrderMessage,
  waMeOrderUrl,
  whatsappDigitsFromPhoneOrLink,
  WHATSAPP_CART_MAX_LINES,
  WHATSAPP_CART_MAX_URL_CHARS,
  type WhatsAppCartBuildResult,
  type WhatsAppCartLine,
} from "./whatsapp-cart";
