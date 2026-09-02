import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { isInServiceWindow } from "@/lib/channels/service-window";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { pauseAiUntil } from "@/lib/inbox/ai-pause";
import { unwrapRelation } from "@/lib/orders/display";

interface RouteContext {
  params: Promise<{ threadId: string }>;
}

const OUTSIDE_WINDOW_MESSAGE =
  "This may not deliver: the customer hasn't messaged in the last 24 hours and free-form replies can fail outside that window";

/**
 * Seller-typed WhatsApp reply on an inbox thread. Reuses sendWhatsAppMessage
 * and extends customers.ai_paused_until by 24 hours.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { threadId } = await context.params;

  let body: { text?: unknown; acknowledgeOutsideWindow?: unknown } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json(
      { ok: false, error: "Enter a reply." },
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

  const { data: rows, error: threadError } = await auth.supabase
    .from("messages")
    .select(
      "customer_id, customers(phone_e164, last_customer_message_at, ai_paused_until)",
    )
    .eq("thread_id", threadId)
    .eq("business_id", business.id)
    .not("customer_id", "is", null)
    .is("deleted_at", null)
    .limit(1);

  if (threadError) {
    return NextResponse.json({ error: threadError.message }, { status: 500 });
  }
  const row = rows?.[0];
  if (!row?.customer_id) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const customer = unwrapRelation(
    row.customers as
      | {
          phone_e164: string;
          last_customer_message_at: string | null;
          ai_paused_until: string | null;
        }
      | {
          phone_e164: string;
          last_customer_message_at: string | null;
          ai_paused_until: string | null;
        }[]
      | null,
  );
  const phone = customer?.phone_e164?.trim();
  if (!phone) {
    return NextResponse.json(
      { ok: false, error: "This thread has no buyer phone number." },
      { status: 400 },
    );
  }

  const inWindow = isInServiceWindow({
    last_customer_message_at: customer?.last_customer_message_at ?? null,
  });
  if (!inWindow && body.acknowledgeOutsideWindow !== true) {
    return NextResponse.json(
      {
        ok: false,
        code: "OUTSIDE_SERVICE_WINDOW",
        error: OUTSIDE_WINDOW_MESSAGE,
      },
      { status: 409 },
    );
  }

  try {
    const sent = await sendWhatsAppMessage({
      businessId: business.id as string,
      toPhoneE164: phone,
      text,
      threadId,
      customerId: row.customer_id as string,
      supabase: auth.supabase,
    });

    const pausedUntil = pauseAiUntil();
    const { error: pauseError } = await auth.supabase
      .from("customers")
      .update({ ai_paused_until: pausedUntil.toISOString() })
      .eq("id", row.customer_id);

    if (pauseError) {
      console.error("[inbox/reply] sent but failed to pause AI", {
        customerId: row.customer_id,
        error: pauseError.message,
      });
    }

    return NextResponse.json({
      ok: true,
      messageId: sent.messageId,
      threadId: sent.threadId,
      aiPausedUntil: pausedUntil.toISOString(),
      outsideServiceWindow: !inWindow,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[inbox/reply] send failed", { threadId, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
