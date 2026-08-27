import { NextResponse, type NextRequest } from "next/server";

import { WhatsAppNotConfiguredError } from "@/lib/channels/send/errors";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Internal verification route — remove or auth-gate before Phase 1 ships
 * (same as /api/internal/test-ai-gateway and /api/internal/test-payment-intent).
 * Note: Next.js treats `_`-prefixed app folders as private (non-routable),
 * so this lives at /api/internal/test-whatsapp-send instead of /api/_internal/...
 *
 * POST JSON: { toPhoneE164, text, businessId? }
 * GET query:  ?to=+44...&text=hello&businessId=<uuid optional>
 *
 * When businessId is omitted, uses the business that currently owns the
 * Twilio sandbox WhatsApp number (whatsapp_phone_e164 = +14155238886).
 */
const SANDBOX_NUMBER = "+14155238886";

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  return handleSend({
    toPhoneE164: params.get("to") ?? params.get("toPhoneE164"),
    text: params.get("text"),
    businessId: params.get("businessId"),
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return handleSend({
    toPhoneE164:
      typeof body.toPhoneE164 === "string"
        ? body.toPhoneE164
        : typeof body.to === "string"
          ? body.to
          : null,
    text: typeof body.text === "string" ? body.text : null,
    businessId: typeof body.businessId === "string" ? body.businessId : null,
  });
}

async function handleSend(input: {
  toPhoneE164: string | null;
  text: string | null;
  businessId: string | null;
}) {
  if (!input.toPhoneE164 || !input.text) {
    return NextResponse.json(
      {
        ok: false,
        error: "Provide toPhoneE164 (or to) and text",
      },
      { status: 400 },
    );
  }

  try {
    const businessId =
      input.businessId ?? (await resolveSandboxBusinessId());

    const result = await sendWhatsAppMessage({
      businessId,
      toPhoneE164: input.toPhoneE164,
      text: input.text,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof WhatsAppNotConfiguredError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          code: error.code,
          businessId: error.businessId,
        },
        { status: 400 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

async function resolveSandboxBusinessId(): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("businesses")
    .select("id")
    .eq("whatsapp_phone_e164", SANDBOX_NUMBER)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error(
      `No business mapped to sandbox number ${SANDBOX_NUMBER}`,
    );
  }
  return data.id;
}
