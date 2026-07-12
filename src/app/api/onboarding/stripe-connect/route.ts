import { NextResponse, type NextRequest } from "next/server";

import {
  createAccountOnboardingLink,
  createExpressConnectedAccount,
} from "@/lib/stripe/connect";
import { createClient } from "@/lib/supabase/server";

/**
 * Starts Stripe Connect Express onboarding for the signed-in user's business.
 *
 * Creates a connected account (if one does not yet exist), stores its id on
 * businesses.stripe_connected_account_id, then returns a hosted onboarding
 * link the client redirects to. Stripe collects and verifies bank details
 * directly, so TradeFlow never handles raw payout credentials.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id, stripe_connected_account_id")
    .eq("owner_user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (businessError) {
    return NextResponse.json({ error: businessError.message }, { status: 500 });
  }
  if (!business) {
    return NextResponse.json(
      { error: "Create your business details before connecting a bank." },
      { status: 400 },
    );
  }

  try {
    let connectedAccountId = business.stripe_connected_account_id;

    if (!connectedAccountId) {
      const account = await createExpressConnectedAccount({
        businessId: business.id,
        email: user.email ?? undefined,
      });
      connectedAccountId = account.id;

      const { error: updateError } = await supabase
        .from("businesses")
        .update({ stripe_connected_account_id: connectedAccountId })
        .eq("id", business.id);

      if (updateError) {
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 },
        );
      }
    }

    const origin = new URL(request.url).origin;
    const url = await createAccountOnboardingLink({
      connectedAccountId,
      refreshUrl: `${origin}/onboarding`,
      returnUrl: `${origin}/dashboard`,
    });

    return NextResponse.json({ url, connectedAccountId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[stripe-connect] Failed to start onboarding", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
