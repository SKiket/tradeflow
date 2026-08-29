import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest } from "@/lib/cron/auth";
import { runLowStockAlerts } from "@/lib/cron/low-stock-alerts";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Daily seller low-stock WhatsApp (batched per business).
 * Authenticated by CRON_SHARED_SECRET. pg_cron: 08:00 UTC.
 */
export async function POST(request: NextRequest) {
  if (!(await authorizeCronRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runLowStockAlerts(createAdminClient());
    console.info("[cron/low-stock-alerts] run complete", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/low-stock-alerts] failed", { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
