import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest } from "@/lib/cron/auth";
import { runWhatsAppDeliveryRetry } from "@/lib/cron/whatsapp-delivery-retry";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Retry failed outbound WhatsApp sends (rate limit / 5xx) with
 * minutes-scale backoff. Invoked by pg_cron every 5 minutes.
 */
export async function POST(request: NextRequest) {
  if (!(await authorizeCronRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const result = await runWhatsAppDeliveryRetry(supabase);
    console.info("[cron/whatsapp-delivery-retry] run complete", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/whatsapp-delivery-retry] failed", { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
