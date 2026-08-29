import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest } from "@/lib/cron/auth";
import { runPaymentChase } from "@/lib/cron/payment-chase";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Scheduled payment-chase: 12h/23h unpaid reminders, 24h auto-cancel.
 * Authenticated by CRON_SHARED_SECRET (header or query). Invoked by
 * Supabase pg_cron + pg_net every 15 minutes — see
 * supabase/migrations/20260829190100_schedule_payment_chase_cron.sql
 */
export async function POST(request: NextRequest) {
  if (!(await authorizeCronRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const result = await runPaymentChase(supabase);
    console.info("[cron/payment-chase] run complete", {
      reminders12h: result.reminders12h.length,
      reminders23h: result.reminders23h.length,
      cancelled: result.cancelled.length,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/payment-chase] failed", { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
