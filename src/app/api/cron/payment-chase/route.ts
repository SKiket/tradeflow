import type { NextRequest } from "next/server";

import { runPaymentChase } from "@/lib/cron/payment-chase";
import { runCronJob } from "@/lib/cron/run";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Scheduled payment-chase: 12h/23h unpaid reminders, 24h auto-cancel.
 * Authenticated by CRON_SHARED_SECRET (header or query). Invoked by
 * Supabase pg_cron + pg_net every 15 minutes.
 */
export async function POST(request: NextRequest) {
  return runCronJob(request, "payment-chase", async () => {
    const result = await runPaymentChase(createAdminClient());
    console.info("[cron/payment-chase] run complete", {
      sent: result.counts.sent,
      skipped: result.counts.skipped,
      failed: result.counts.failed,
      cancelled: result.counts.cancelled,
      cancelErrors: result.counts.cancelErrors,
      reminders12h: result.reminders12h.length,
      reminders23h: result.reminders23h.length,
    });
    return {
      counts: result.counts,
      reminders12h: result.reminders12h,
      reminders23h: result.reminders23h,
      cancelled: result.cancelled,
      runSummary: `sent=${result.counts.sent} skipped=${result.counts.skipped} failed=${result.counts.failed} cancelled=${result.counts.cancelled}`,
    };
  });
}
