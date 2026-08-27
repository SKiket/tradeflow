import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";

/**
 * Persist stripe_payment_intent_id on an order from its Checkout Session.
 * Called at fulfilment time; safe to call if already stored.
 */
export async function capturePaymentIntentForOrder(orderId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data: order } = await supabase
    .from("orders")
    .select("stripe_checkout_session_id, stripe_payment_intent_id")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) return null;
  if (order.stripe_payment_intent_id) {
    return order.stripe_payment_intent_id;
  }
  if (!order.stripe_checkout_session_id) return null;

  const session = await getStripe().checkout.sessions.retrieve(
    order.stripe_checkout_session_id,
  );
  const piRaw = session.payment_intent;
  const paymentIntentId =
    typeof piRaw === "string" ? piRaw : piRaw?.id ?? null;

  if (!paymentIntentId) return null;

  await supabase
    .from("orders")
    .update({ stripe_payment_intent_id: paymentIntentId })
    .eq("id", orderId);

  return paymentIntentId;
}
