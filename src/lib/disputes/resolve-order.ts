import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { getStripe } from "@/lib/stripe/client";

export type DisputeOrderMatch = {
  orderId: string | null;
  businessId: string | null;
  paymentIntentId: string | null;
  chargeId: string;
  transferId: string | null;
};

/**
 * Map a Stripe Dispute → TradeFlow order.
 * Path: charge → payment_intent → orders.stripe_payment_intent_id,
 * fallback PaymentIntent / Checkout Session metadata.order_id.
 */
export async function resolveOrderForDispute(
  supabase: SupabaseClient,
  dispute: Stripe.Dispute,
): Promise<DisputeOrderMatch> {
  const stripe = getStripe();
  const chargeId =
    typeof dispute.charge === "string"
      ? dispute.charge
      : dispute.charge?.id ?? "";

  let paymentIntentId: string | null =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id ?? null;

  let transferId: string | null = null;
  let charge: Stripe.Charge | null = null;

  if (chargeId) {
    try {
      charge = await stripe.charges.retrieve(chargeId);
      if (!paymentIntentId) {
        paymentIntentId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null;
      }
      transferId =
        typeof charge.transfer === "string"
          ? charge.transfer
          : charge.transfer?.id ?? null;
      // Destination charges may expose transfer via source_transfer / transfer_data.
      if (!transferId && charge.transfer_data?.destination) {
        // List transfers for this charge via transfer_group or destination payment.
        const transfers = await stripe.transfers.list({
          transfer_group: charge.transfer_group ?? undefined,
          limit: 5,
        });
        const match = transfers.data.find(
          (t) =>
            t.source_transaction === chargeId ||
            t.destination === charge!.transfer_data!.destination,
        );
        transferId = match?.id ?? null;
      }
    } catch {
      // Charge may be unavailable; continue with PI / metadata paths.
    }
  }

  if (paymentIntentId) {
    const { data: byPi } = await supabase
      .from("orders")
      .select("id, business_id")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .is("deleted_at", null)
      .maybeSingle();
    if (byPi) {
      return {
        orderId: byPi.id as string,
        businessId: byPi.business_id as string,
        paymentIntentId,
        chargeId,
        transferId,
      };
    }
  }

  // Older orders: PaymentIntent metadata.order_id
  if (paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      const metaOrderId = pi.metadata?.order_id;
      if (typeof metaOrderId === "string" && metaOrderId.length > 0) {
        const { data: byMeta } = await supabase
          .from("orders")
          .select("id, business_id")
          .eq("id", metaOrderId)
          .is("deleted_at", null)
          .maybeSingle();
        if (byMeta) {
          return {
            orderId: byMeta.id as string,
            businessId: byMeta.business_id as string,
            paymentIntentId,
            chargeId,
            transferId,
          };
        }
      }

      // Checkout session from PI
      const sessions = await stripe.checkout.sessions.list({
        payment_intent: paymentIntentId,
        limit: 1,
      });
      const session = sessions.data[0];
      const sessionOrderId = session?.metadata?.order_id;
      if (typeof sessionOrderId === "string" && sessionOrderId.length > 0) {
        const { data: bySession } = await supabase
          .from("orders")
          .select("id, business_id")
          .eq("id", sessionOrderId)
          .is("deleted_at", null)
          .maybeSingle();
        if (bySession) {
          return {
            orderId: bySession.id as string,
            businessId: bySession.business_id as string,
            paymentIntentId,
            chargeId,
            transferId,
          };
        }
      }
      if (session?.id) {
        const { data: byCheckout } = await supabase
          .from("orders")
          .select("id, business_id")
          .eq("stripe_checkout_session_id", session.id)
          .is("deleted_at", null)
          .maybeSingle();
        if (byCheckout) {
          return {
            orderId: byCheckout.id as string,
            businessId: byCheckout.business_id as string,
            paymentIntentId,
            chargeId,
            transferId,
          };
        }
      }
    } catch {
      // ignore lookup failures
    }
  }

  return {
    orderId: null,
    businessId: null,
    paymentIntentId,
    chargeId,
    transferId,
  };
}
