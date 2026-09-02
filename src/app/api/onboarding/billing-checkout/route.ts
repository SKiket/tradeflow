import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import {
  createSellerSubscriptionCheckout,
  getOrCreateSellerCustomer,
} from "@/lib/stripe/billing";
import { canAcceptOrders } from "@/lib/stripe/billing-gate";

/**
 * Creates a Stripe Customer (platform account) for the seller's business,
 * then a subscription Checkout Session with a 30-day trial. Card is
 * collected; nothing is charged until the trial ends.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { user, supabase } = auth;
  const { business, error: businessError } = await resolveActiveOwnedBusiness(
    supabase,
    user.id,
  );

  if (businessError) {
    return NextResponse.json({ error: businessError }, { status: 500 });
  }
  if (!business) {
    return NextResponse.json(
      { error: "Create your business details before starting a trial." },
      { status: 400 },
    );
  }

  if (
    canAcceptOrders({
      stripe_subscription_status:
        (business.stripe_subscription_status as string | null) ?? null,
    })
  ) {
    return NextResponse.json(
      { error: "A TradeFlow subscription is already in place. Use Manage billing to update it." },
      { status: 400 },
    );
  }

  try {
    const customer = await getOrCreateSellerCustomer({
      businessId: business.id,
      existingCustomerId: business.stripe_customer_id as string | null,
      email: user.email ?? undefined,
      name: (business.name as string | null) ?? undefined,
    });

    if (customer.id !== business.stripe_customer_id) {
      const { error: updateError } = await supabase
        .from("businesses")
        .update({ stripe_customer_id: customer.id })
        .eq("id", business.id);
      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
    }

    const origin = new URL(request.url).origin;
    const session = await createSellerSubscriptionCheckout({
      customerId: customer.id,
      businessId: business.id,
      successUrl: `${origin}/dashboard/settings?billing=success`,
      cancelUrl: `${origin}/dashboard/settings?billing=cancelled`,
    });

    if (!session.url) {
      return NextResponse.json(
        { error: "Checkout session has no URL" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      url: session.url,
      customerId: customer.id,
      sessionId: session.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[billing-checkout] Failed to start trial", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
