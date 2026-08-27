import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { initiateRefund } from "@/lib/orders/refund-order";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

/**
 * Initiate a full or partial refund on a paid order.
 * Sets REFUND_PENDING immediately; final state comes from refund.updated webhook.
 *
 * Stock is NOT restocked — physical returns are out of scope.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  let body: { amountPence?: number; reason?: string } = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      body = JSON.parse(text) as typeof body;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const outcome = await initiateRefund(auth.supabase, orderId, {
      amountPence: body.amountPence,
      reason: body.reason,
    });

    switch (outcome.action) {
      case "refund_pending":
        return NextResponse.json({ ok: true, ...outcome });
      case "invalid_status":
        return NextResponse.json(
          {
            ok: false,
            error: `Cannot refund order in status ${outcome.status}`,
            orderId: outcome.orderId,
            status: outcome.status,
          },
          { status: 400 },
        );
      case "amount_exceeds_refundable":
        return NextResponse.json(
          {
            ok: false,
            error: "Refund amount exceeds remaining refundable total",
            orderId: outcome.orderId,
            requested: outcome.requested,
            refundable: outcome.refundable,
          },
          { status: 400 },
        );
      case "missing_payment_intent":
        return NextResponse.json(
          {
            ok: false,
            error: "Order has no Stripe payment intent — cannot refund",
            orderId: outcome.orderId,
          },
          { status: 400 },
        );
      case "refund_in_progress":
        return NextResponse.json(
          {
            ok: false,
            error: "A refund is already in progress for this order",
            orderId: outcome.orderId,
          },
          { status: 409 },
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "ORDER_NOT_FOUND") {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    console.error("[orders/refund] failed", { orderId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
