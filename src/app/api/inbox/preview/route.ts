import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { previewInboundMessage } from "@/lib/inbox/preview-inbound";

/**
 * Sandbox: run order_parse / support_reply against the seller's live catalog.
 * Never sends WhatsApp, never writes messages, never creates orders.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { message?: string } = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      body = JSON.parse(text) as typeof body;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = body.message?.trim() ?? "";
  if (!message) {
    return NextResponse.json(
      { ok: false, error: "Enter a sample buyer message." },
      { status: 400 },
    );
  }

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

  try {
    const preview = await previewInboundMessage({
      businessId: business.id as string,
      messageText: message,
      supabase: auth.supabase,
    });
    return NextResponse.json({ ok: true, ...preview });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error("[inbox/preview] failed", { error: messageText });
    return NextResponse.json({ ok: false, error: messageText }, { status: 500 });
  }
}
