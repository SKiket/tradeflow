import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { runInboxAssist, type AssistMock } from "@/lib/assist/run-assist";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ threadId: string }>;
}

/**
 * Polish or draft an Inbox reply. Never sends WhatsApp — seller remains author.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { threadId } = await context.params;

  let body: {
    action?: unknown;
    text?: unknown;
    uiLang?: unknown;
    mock?: unknown;
  } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action === "draft" ? "draft" : body.action === "polish" ? "polish" : null;
  if (!action) {
    return NextResponse.json(
      { ok: false, error: "action must be polish or draft" },
      { status: 400 },
    );
  }

  const text = typeof body.text === "string" ? body.text : "";
  const uiLang = typeof body.uiLang === "string" ? body.uiLang : "en";

  const allowMock =
    process.env.NODE_ENV !== "production" &&
    request.headers.get("X-TradeFlow-Verify") === "1";
  const mock =
    allowMock && body.mock && typeof body.mock === "object"
      ? (body.mock as AssistMock)
      : null;

  const { business, error: bizError } = await resolveActiveOwnedBusiness(
    auth.supabase,
    auth.user.id,
  );
  if (bizError) {
    return NextResponse.json({ error: bizError }, { status: 500 });
  }
  if (!business) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }

  // Service-role for usage counter (RLS revoked for authenticated).
  const admin = createAdminClient();

  // Tenant check: thread must belong to this business (runInboxAssist also checks).
  const { data: owned } = await auth.supabase
    .from("messages")
    .select("id")
    .eq("thread_id", threadId)
    .eq("business_id", business.id)
    .limit(1);
  if (!owned?.length) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const result = await runInboxAssist({
    supabase: admin,
    businessId: business.id as string,
    threadId,
    action,
    sellerText: text,
    uiLang,
    mock,
  });

  if (!result.ok) {
    const status =
      result.code === "not_found"
        ? 404
        : result.code === "empty"
          ? 400
          : 200; // soft fail — UI shows friendly message, send still works
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        code: result.code,
        ...(allowMock && result.scrubbedPayload
          ? { scrubbedPayload: result.scrubbedPayload }
          : {}),
      },
      { status },
    );
  }

  return NextResponse.json({
    ok: true,
    action: result.action,
    suggestion: result.suggestion,
    original: result.original,
    translated: result.translated,
    translationLabel: result.translationLabel,
    placeholders: result.placeholders,
    newDetails: result.newDetails,
    sellerNeeded: result.sellerNeeded,
    ...(allowMock ? { scrubbedPayload: result.scrubbedPayload } : {}),
  });
}
