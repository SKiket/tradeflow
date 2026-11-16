import type { NextRequest } from "next/server";

import { runLowStockAlerts } from "@/lib/cron/low-stock-alerts";
import { runCronJob } from "@/lib/cron/run";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Daily seller low-stock WhatsApp (batched per business).
 * Authenticated by CRON_SHARED_SECRET. pg_cron: 08:00 UTC.
 */
export async function POST(request: NextRequest) {
  return runCronJob(request, "low-stock-alerts", async () => {
    const result = await runLowStockAlerts(createAdminClient());
    console.info("[cron/low-stock-alerts] run complete", result);
    return result as unknown as Record<string, unknown>;
  });
}
