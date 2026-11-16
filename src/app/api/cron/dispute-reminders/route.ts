import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest } from "@/lib/cron/auth";
import { runDisputeReminders } from "@/lib/disputes/reminders";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Dispute evidence reminders (5d / 2d / 1d) and auto-submit fallback.
 * Authenticated by CRON_SHARED_SECRET. Invoked by Supabase pg_cron —
 * see supabase/schedule_dispute_reminders_cron.sql (operator-run).
 */
export async function POST(request: NextRequest) {
  if (!(await authorizeCronRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const result = await runDisputeReminders(supabase);
    console.info("[cron/dispute-reminders] run complete", {
      reminders5d: result.reminders5d.length,
      reminders2d: result.reminders2d.length,
      reminders1d: result.reminders1d.length,
      autoSubmitted: result.autoSubmitted.length,
      errors: result.errors.length,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/dispute-reminders] failed", { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
