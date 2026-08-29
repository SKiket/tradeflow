import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { dispatchOrder } from "@/lib/orders/dispatch-order";
import { DispatchPrepError } from "@/lib/orders/shipping-rates";
import { ShippoClientError, purchaseLabel } from "@/lib/shippo/client";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

/**
 * Purchase a Shippo rate then mark the order DISPATCHED.
 * Fail closed: label errors leave the order PAID.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  let body: {
    rateObjectId?: string;
    shipmentId?: string;
    carrier?: string;
  } = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      body = JSON.parse(text) as typeof body;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const { data: current } = await auth.supabase
      .from("orders")
      .select("id, status")
      .eq("id", orderId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!current) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (current.status === "DISPATCHED" || current.status === "DELIVERED") {
      return NextResponse.json({
        ok: true,
        action: "no_op",
        reason: "already_dispatched",
        orderId,
      });
    }
    if (current.status !== "PAID") {
      return NextResponse.json(
        {
          ok: false,
          error: `Cannot dispatch order in status ${current.status}`,
          orderId,
          status: current.status,
        },
        { status: 400 },
      );
    }

    const rateObjectId = body.rateObjectId?.trim();
    if (!rateObjectId) {
      return NextResponse.json(
        { ok: false, error: "Select a shipping rate before dispatching." },
        { status: 400 },
      );
    }

    const transaction = await purchaseLabel(rateObjectId);
    const trackingNumber = transaction.tracking_number?.trim();
    const labelUrl = transaction.label_url?.trim() || null;
    const carrierFromRate =
      transaction.rate && typeof transaction.rate === "object"
        ? transaction.rate.provider
        : null;
    const carrier = (body.carrier?.trim() || carrierFromRate || "").trim();

    if (transaction.status && transaction.status !== "SUCCESS") {
      const hint = (transaction.messages ?? [])
        .map((entry) => entry.text)
        .filter(Boolean)
        .join(" ");
      return NextResponse.json(
        {
          ok: false,
          error:
            hint ||
            `Shippo could not purchase that label (${transaction.status}). The order was not dispatched.`,
        },
        { status: 400 },
      );
    }
    if (!trackingNumber || !labelUrl) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Shippo did not return a tracking number and label. The order was not dispatched.",
        },
        { status: 400 },
      );
    }

    const outcome = await dispatchOrder(auth.supabase, orderId, {
      trackingNumber,
      carrier: carrier || "Carrier",
      labelUrl,
      shippoShipmentId: body.shipmentId,
      shippoTransactionId: transaction.object_id,
    });

    switch (outcome.action) {
      case "dispatched":
        return NextResponse.json({
          ok: true,
          ...outcome,
          trackingNumber,
          carrier: carrier || "Carrier",
          labelUrl,
          shippoTransactionId: transaction.object_id,
          shippoShipmentId: body.shipmentId ?? null,
        });
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
    if (error instanceof DispatchPrepError || error instanceof ShippoClientError) {
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
    console.error("[orders/dispatch] failed", { orderId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
