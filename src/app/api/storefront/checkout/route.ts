import { NextResponse, type NextRequest } from "next/server";

import {
  PlaceStorefrontOrderError,
  placeStorefrontOrder,
} from "@/lib/orders/place-storefront-order";

/**
 * Public storefront checkout. No auth — the buyer is not a TradeFlow user.
 * Trusts nothing from the body except as input to placeStorefrontOrder,
 * which re-prices from the catalog and re-checks live stock.
 */
export async function POST(request: NextRequest) {
  let body: {
    businessId?: unknown;
    items?: unknown;
    customerName?: unknown;
    customerPhone?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const items = Array.isArray(body.items) ? body.items : [];

  try {
    const result = await placeStorefrontOrder({
      businessId: typeof body.businessId === "string" ? body.businessId : "",
      customerName:
        typeof body.customerName === "string" ? body.customerName : "",
      customerPhone:
        typeof body.customerPhone === "string" ? body.customerPhone : "",
      items: items.map((item) => {
        const row = item as { variantId?: unknown; quantity?: unknown };
        return {
          variantId: typeof row.variantId === "string" ? row.variantId : "",
          quantity: typeof row.quantity === "number" ? row.quantity : Number(row.quantity),
        };
      }),
    });

    return NextResponse.json({
      ok: true,
      checkoutUrl: result.checkoutUrl,
      orderId: result.orderId,
      orderRef: result.orderRef,
      totalPence: result.totalPence,
    });
  } catch (error) {
    if (error instanceof PlaceStorefrontOrderError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          code: error.code,
          ...(error.extra ?? {}),
        },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[storefront/checkout] unexpected error", { message });
    return NextResponse.json(
      { ok: false, error: "Could not place that order. Please try again." },
      { status: 500 },
    );
  }
}
