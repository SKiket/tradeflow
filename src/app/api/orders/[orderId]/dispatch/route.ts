import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { dispatchOrder } from "@/lib/orders/dispatch-order";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

/**
 * Mark a PAID order as DISPATCHED and notify the buyer via WhatsApp.
 * Authenticated — seller must own the order (enforced by RLS).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  let body: { trackingNumber?: string; carrier?: string } = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      body = JSON.parse(text) as typeof body;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const outcome = await dispatchOrder(auth.supabase, orderId, {
      trackingNumber: body.trackingNumber,
      carrier: body.carrier,
    });

    switch (outcome.action) {
      case "dispatched":
        return NextResponse.json({ ok: true, ...outcome });
      case "already_dispatched":
        return NextResponse.json({
          ok: true,
          action: "no_op",
          reason: "already_dispatched",
          orderId: outcome.orderId,
          orderRef: outcome.orderRef,
        });
      case "invalid_status":
        return NextResponse.json(
          {
            ok: false,
            error: `Cannot dispatch order in status ${outcome.status}`,
            orderId: outcome.orderId,
            status: outcome.status,
          },
          { status: 400 },
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "ORDER_NOT_FOUND") {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    console.error("[orders/dispatch] failed", { orderId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
