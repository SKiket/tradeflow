import type { NextRequest } from "next/server";

import { runCronJob } from "@/lib/cron/run";
import { purgeDueShops } from "@/lib/privacy/shop-lifecycle";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * After grace period, permanently erase closed shops.
 * Authenticated by CRON_SHARED_SECRET.
 * ?dry_run=true → counts only.
 */
export async function POST(request: NextRequest) {
  return runCronJob(request, "shop-purge", async () => {
    const dryRun =
      request.nextUrl.searchParams.get("dry_run") === "true" ||
      request.nextUrl.searchParams.get("dry-run") === "true";
    const summary = await purgeDueShops(createAdminClient(), { dryRun });
    console.info("[cron/shop-purge] complete", {
      dryRun,
      dueTotal: summary.dueTotal,
      processed: summary.processed,
      remaining: summary.remaining,
      purged: summary.purged,
      skipped: summary.skipped,
      failed: summary.failed,
    });
    return { dryRun, ...summary };
  });
}
