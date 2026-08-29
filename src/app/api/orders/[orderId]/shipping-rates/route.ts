import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import {
  DispatchPrepError,
  quoteShippingRates,
} from "@/lib/orders/shipping-rates";
import { ShippoClientError } from "@/lib/shippo/client";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

/**
 * Quote real Shippo rates for a PAID order. Does not purchase a label
 * and does not change order status.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  try {
    const quoted = await quoteShippingRates(auth.supabase, orderId);
    return NextResponse.json({ ok: true, ...quoted });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Order not found" || message.includes("Order not found")) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (error instanceof DispatchPrepError || error instanceof ShippoClientError) {
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
    console.error("[orders/shipping-rates] failed", { orderId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
