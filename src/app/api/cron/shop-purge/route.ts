import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest } from "@/lib/cron/auth";
import { purgeDueShops } from "@/lib/privacy/shop-lifecycle";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * After grace period, permanently erase closed shops.
 * Authenticated by CRON_SHARED_SECRET. Fail-closed if unset.
 * ?dry_run=true → counts only.
 */
export async function POST(request: NextRequest) {
  if (!(await authorizeCronRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun =
    request.nextUrl.searchParams.get("dry_run") === "true" ||
    request.nextUrl.searchParams.get("dry-run") === "true";

  try {
    const supabase = createAdminClient();
    const summary = await purgeDueShops(supabase, { dryRun });
    console.info("[cron/shop-purge] complete", {
      dryRun,
      dueTotal: summary.dueTotal,
      processed: summary.processed,
      remaining: summary.remaining,
      purged: summary.purged,
      skipped: summary.skipped,
      failed: summary.failed,
    });
    return NextResponse.json({ ok: true, dryRun, ...summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/shop-purge] failed", message);
    return NextResponse.json({ error: "Purge failed" }, { status: 500 });
  }
}
