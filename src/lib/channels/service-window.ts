/**
 * WhatsApp 24-hour customer care window.
 *
 * Businesses may send free-form messages only within 24 hours of the
 * customer's last inbound message; outside it, only pre-approved templates are
 * allowed. Future outbound send logic (order confirmations, shipping updates,
 * broadcasts) imports this to decide which path to take.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#customer-service-windows
 */

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimal shape needed for the check — matches the customers row. */
export interface ServiceWindowCustomer {
  last_customer_message_at: string | null;
}

/**
 * Returns true if the customer messaged within the last 24 hours.
 *
 * Returns false when they have never messaged (last_customer_message_at is
 * null/undefined) or when the timestamp is unparseable — never throws.
 */
export function isInServiceWindow(
  customer: ServiceWindowCustomer,
  now: Date = new Date(),
): boolean {
  const last = customer.last_customer_message_at;
  if (!last) return false;

  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return false;

  return now.getTime() - lastMs < SERVICE_WINDOW_MS;
}
