import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest } from "@/lib/cron/auth";
import { runPendingReplay } from "@/lib/cron/pending-replay";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Replay inbound messages that never got a delivered buyer reply.
 * pg_cron every 15 minutes.
 */
export async function POST(request: NextRequest) {
  if (!(await authorizeCronRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const result = await runPendingReplay(supabase);
    console.info("[cron/pending-replay] run complete", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/pending-replay] failed", { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
