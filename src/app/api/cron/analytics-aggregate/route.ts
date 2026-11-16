import type { NextRequest } from "next/server";

import { runAnalyticsAggregate } from "@/lib/cron/analytics-aggregate";
import { runCronJob } from "@/lib/cron/run";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Hourly analytics_cache recompute for the last 3 UTC days.
 * Authenticated by CRON_SHARED_SECRET.
 *
 * Dashboard analytics does not read this cache.
 */
export async function POST(request: NextRequest) {
  return runCronJob(request, "analytics-aggregate", async () => {
    const result = await runAnalyticsAggregate(createAdminClient());
    console.info("[cron/analytics-aggregate] run complete", result);
    return result as unknown as Record<string, unknown>;
  });
}
