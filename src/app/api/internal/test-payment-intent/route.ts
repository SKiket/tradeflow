import { NextResponse, type NextRequest } from "next/server";

import { createDestinationPaymentIntent } from "@/lib/stripe/payments";

/**
 * Internal verification route — remove or auth-gate before Phase 1 ships.
 *
 * Proves the destination-charge PaymentIntent stub works end to end. Pass the
 * seller's connected account id as `?account=acct_...` (and optionally
 * `?amount=<pence>`). There is no buyer-facing checkout UI yet.
 */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const connectedAccountId = params.get("account");
  const amountPence = Number(params.get("amount") ?? "1000");

  if (!connectedAccountId) {
    return NextResponse.json(
      { ok: false, error: "Missing ?account=acct_... query parameter" },
      { status: 400 },
    );
  }

  try {
    const intent = await createDestinationPaymentIntent({
      connectedAccountId,
      amountPence,
      orderRef: "TEST-ORDER",
    });

    return NextResponse.json({
      ok: true,
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      paymentMethodTypes: intent.payment_method_types,
      destination: intent.transfer_data?.destination ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
