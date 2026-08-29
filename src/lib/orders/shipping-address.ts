import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Stored on orders.shipping_address. Stripe postal_code → postcode. */
export interface OrderShippingAddress {
  line1: string;
  line2: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
}

type StripeAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

type StripeShippingDetails = {
  address?: StripeAddress | null;
  name?: string | null;
} | null;

/**
 * Read the collected shipping address off a Checkout Session.
 * Newer API versions nest it under collected_information; webhook payloads
 * may still include the older top-level shipping_details.
 */
export function shippingAddressFromSession(
  session: Stripe.Checkout.Session,
): OrderShippingAddress | null {
  const collected = session.collected_information?.shipping_details ?? null;
  const legacy = (
    session as Stripe.Checkout.Session & {
      shipping_details?: StripeShippingDetails;
    }
  ).shipping_details;
  const details = collected ?? legacy;
  const address = details?.address;
  const line1 = address?.line1?.trim();
  if (!line1) return null;

  return {
    line1,
    line2: nullish(address?.line2),
    city: nullish(address?.city),
    postcode: nullish(address?.postal_code),
    country: nullish(address?.country),
  };
}

function nullish(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Persist the first captured address. Compare-and-swap on null so webhook
 * redelivery does not clobber a later correction.
 */
export async function persistOrderShippingAddress(
  supabase: SupabaseClient,
  orderId: string,
  address: OrderShippingAddress | null,
): Promise<void> {
  if (!address) return;
  const { error } = await supabase
    .from("orders")
    .update({ shipping_address: address })
    .eq("id", orderId)
    .is("shipping_address", null);
  if (error) {
    console.error("[orders] shipping_address persist failed", {
      orderId,
      error: error.message,
    });
  }
}
