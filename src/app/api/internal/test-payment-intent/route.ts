import { NextResponse, type NextRequest } from "next/server";

import { notFoundInProduction } from "@/lib/api/internal-only";
import { createDestinationPaymentIntent } from "@/lib/stripe/payments";

/**
 * Internal verification route. Hidden with 404 in production.
 *
 * Proves the destination-charge PaymentIntent stub works end to end. Pass the
 * seller's connected account id as `?account=acct_...` (and optionally
 * `?amount=<pence>`).
 */
export async function GET(request: NextRequest) {
  const blocked = notFoundInProduction();
  if (blocked) return blocked;

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
