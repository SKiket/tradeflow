import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest } from "@/lib/cron/auth";
import { runAnalyticsAggregate } from "@/lib/cron/analytics-aggregate";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Hourly analytics_cache recompute for the last 3 UTC days.
 * Authenticated by CRON_SHARED_SECRET.
 *
 * Dashboard analytics does not read this cache.
 */
export async function POST(request: NextRequest) {
  if (!(await authorizeCronRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runAnalyticsAggregate(createAdminClient());
    console.info("[cron/analytics-aggregate] run complete", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/analytics-aggregate] failed", { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
