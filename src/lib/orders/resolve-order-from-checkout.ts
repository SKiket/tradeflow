import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve a TradeFlow order id from a Stripe Checkout Session.
 * Checks metadata.order_id first, then stripe_checkout_session_id on orders.
 */
export async function resolveOrderIdFromCheckoutSession(
  supabase: SupabaseClient,
  session: Pick<Stripe.Checkout.Session, "id" | "metadata">,
): Promise<string | null> {
  const fromMeta = session.metadata?.order_id;
  if (typeof fromMeta === "string" && fromMeta.length > 0) {
    return fromMeta;
  }

  if (!session.id) return null;

  const { data: order } = await supabase
    .from("orders")
    .select("id")
    .eq("stripe_checkout_session_id", session.id)
    .maybeSingle();

  return order?.id ?? null;
}
