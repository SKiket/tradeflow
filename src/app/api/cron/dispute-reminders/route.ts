import type { NextRequest } from "next/server";

import { runCronJob } from "@/lib/cron/run";
import { runDisputeReminders } from "@/lib/disputes/reminders";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Dispute evidence reminders (5d / 2d / 1d) and auto-submit fallback.
 * Authenticated by CRON_SHARED_SECRET. Invoked by Supabase pg_cron hourly.
 */
export async function POST(request: NextRequest) {
  return runCronJob(request, "dispute-reminders", async () => {
    const result = await runDisputeReminders(createAdminClient());
    console.info("[cron/dispute-reminders] run complete", {
      reminders5d: result.reminders5d.length,
      reminders2d: result.reminders2d.length,
      reminders1d: result.reminders1d.length,
      autoSubmitted: result.autoSubmitted.length,
      autoSkipped: result.autoSkipped.length,
      errors: result.errors.length,
    });
    return {
      reminders5d: result.reminders5d,
      reminders2d: result.reminders2d,
      reminders1d: result.reminders1d,
      autoSubmitted: result.autoSubmitted,
      autoSkipped: result.autoSkipped,
      errors: result.errors,
    };
  });
}
