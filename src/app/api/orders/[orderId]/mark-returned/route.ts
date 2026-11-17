import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { getBusinessSellerLanguage } from "@/lib/channels/templates/business-language";
import { markReturned } from "@/lib/orders/request-return";
import { resolveReturnsLang } from "@/lib/returns/returns-copy";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

const FAIL_COPY = {
  en: "We couldn't update stock. Nothing was changed, please try again.",
  fr: "Impossible de mettre à jour le stock. Rien n’a été modifié, veuillez réessayer.",
} as const;

/**
 * Seller marks a RETURN_APPROVED order as RETURNED (parcel received).
 * Body: { restock?: boolean } — default true; false skips inventory restock.
 * Authenticated — seller must own the order (enforced by RLS before service RPC).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  let restock = true;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      restock?: unknown;
    };
    if (typeof body.restock === "boolean") {
      restock = body.restock;
    }
  } catch {
    restock = true;
  }

  try {
    const { data: current } = await auth.supabase
      .from("orders")
      .select("id, business_id")
      .eq("id", orderId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!current) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const outcome = await markReturned(auth.supabase, orderId, { restock });

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
      case "mark_returned_failed": {
        Sentry.captureException(new Error("mark_returned_failed"), {
          tags: { code: "mark_returned_failed" },
          extra: { orderId: outcome.orderId },
        });
        const sellerLang = await getBusinessSellerLanguage(
          auth.supabase,
          current.business_id as string,
        );
        const lang = resolveReturnsLang(sellerLang);
        return NextResponse.json(
          {
            ok: false,
            code: "mark_returned_failed",
            error: FAIL_COPY[lang],
            orderId: outcome.orderId,
          },
          { status: 500 },
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[orders/mark-returned] failed", { orderId, message });
    Sentry.captureException(
      error instanceof Error ? error : new Error(message),
      {
        tags: { code: "mark_returned_failed" },
        extra: { orderId },
      },
    );
    let lang: "en" | "fr" = "en";
    try {
      const { data: row } = await auth.supabase
        .from("orders")
        .select("business_id")
        .eq("id", orderId)
        .maybeSingle();
      if (row?.business_id) {
        const sellerLang = await getBusinessSellerLanguage(
          auth.supabase,
          row.business_id as string,
        );
        lang = resolveReturnsLang(sellerLang);
      }
    } catch {
      /* keep en */
    }
    return NextResponse.json(
      {
        ok: false,
        code: "mark_returned_failed",
        error: FAIL_COPY[lang],
        orderId,
      },
      { status: 500 },
    );
  }
}
