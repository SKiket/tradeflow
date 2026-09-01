import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { createSellerBillingPortalSession } from "@/lib/stripe/billing";

/**
 * Opens Stripe's hosted Billing Portal for the seller's platform Customer.
 * No custom billing UI — card updates, cancellation, and invoices live there.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { user, supabase } = auth;
  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id, stripe_customer_id")
    .eq("owner_user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (businessError) {
    return NextResponse.json({ error: businessError.message }, { status: 500 });
  }
  if (!business) {
    return NextResponse.json({ error: "Business not found." }, { status: 400 });
  }

  const customerId = business.stripe_customer_id as string | null;
  if (!customerId) {
    return NextResponse.json(
      { error: "No billing customer yet. Start a trial first." },
      { status: 400 },
    );
  }

  try {
    const origin = new URL(request.url).origin;
    const session = await createSellerBillingPortalSession({
      customerId,
      returnUrl: `${origin}/dashboard/settings`,
    });
    return NextResponse.json({ url: session.url, customerId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[billing-portal] Failed to create portal session", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
