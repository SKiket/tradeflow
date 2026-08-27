import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { deliverOrder } from "@/lib/orders/dispatch-order";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

/**
 * Mark a DISPATCHED order as DELIVERED and notify the buyer via WhatsApp.
 * Authenticated — seller must own the order (enforced by RLS).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  try {
    const outcome = await deliverOrder(auth.supabase, orderId);

    switch (outcome.action) {
      case "delivered":
        return NextResponse.json({ ok: true, ...outcome });
      case "already_delivered":
        return NextResponse.json({
          ok: true,
          action: "no_op",
          reason: "already_delivered",
          orderId: outcome.orderId,
          orderRef: outcome.orderRef,
        });
      case "not_dispatched":
        return NextResponse.json(
          {
            ok: false,
            error: "Order must be dispatched before it can be marked delivered",
            orderId: outcome.orderId,
            status: outcome.status,
          },
          { status: 400 },
        );
      case "invalid_status":
        return NextResponse.json(
          {
            ok: false,
            error: `Cannot deliver order in status ${outcome.status}`,
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
    console.error("[orders/deliver] failed", { orderId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
