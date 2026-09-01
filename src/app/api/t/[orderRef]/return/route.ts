import { NextResponse, type NextRequest } from "next/server";

import { requestReturnByOrderRef } from "@/lib/orders/request-return";
import { parseReturnReason } from "@/lib/orders/return-reasons";
import { createAdminClient } from "@/lib/supabase/admin";
import { PUBLIC_ORDER_REF_RE } from "@/lib/tracking/public-order";

interface RouteContext {
  params: Promise<{ orderRef: string }>;
}

/**
 * Public tracking-page return request. Same requestReturn() as WhatsApp.
 * order_ref is globally unique; no auth — possession of the tracking URL is the gate.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { orderRef } = await context.params;
  const trimmed = decodeURIComponent(orderRef).trim();
  if (!PUBLIC_ORDER_REF_RE.test(trimmed)) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  let body: { reason?: string; detail?: string } = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      body = JSON.parse(text) as typeof body;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reason = parseReturnReason(body.reason);
  if (!reason) {
    return NextResponse.json(
      { ok: false, error: "Choose a return reason" },
      { status: 400 },
    );
  }

  const detail = typeof body.detail === "string" ? body.detail : null;

  try {
    const supabase = createAdminClient();
    const outcome = await requestReturnByOrderRef(
      supabase,
      trimmed,
      reason,
      detail,
    );

    switch (outcome.action) {
      case "requested":
        return NextResponse.json({ ok: true, ...outcome });
      case "already_requested":
        return NextResponse.json(
          {
            ok: false,
            error: "A return has already been requested for this order",
            ...outcome,
          },
          { status: 409 },
        );
      case "not_delivered":
        return NextResponse.json(
          {
            ok: false,
            error: `A return can only be requested after the order has been delivered. This order is currently ${outcome.status}.`,
            ...outcome,
          },
          { status: 400 },
        );
      case "invalid_reason":
        return NextResponse.json(
          { ok: false, error: "Choose a return reason" },
          { status: 400 },
        );
      case "not_found":
        return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[t/return] failed", { orderRef: trimmed, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
