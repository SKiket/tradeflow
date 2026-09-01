import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { markReturned } from "@/lib/orders/request-return";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

/**
 * Seller marks a RETURN_APPROVED order as RETURNED (parcel received).
 * Authenticated — seller must own the order (enforced by RLS).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  try {
    const { data: current } = await auth.supabase
      .from("orders")
      .select("id")
      .eq("id", orderId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!current) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const outcome = await markReturned(auth.supabase, orderId);

    switch (outcome.action) {
      case "returned":
        return NextResponse.json({ ok: true, ...outcome });
      case "invalid_status":
        return NextResponse.json(
          {
            ok: false,
            error: `Cannot mark returned from status ${outcome.status}`,
            orderId: outcome.orderId,
            status: outcome.status,
          },
          { status: 400 },
        );
      case "not_found":
        return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[orders/mark-returned] failed", { orderId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
