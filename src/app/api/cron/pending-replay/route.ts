import type { NextRequest } from "next/server";

import { runPendingReplay } from "@/lib/cron/pending-replay";
import { runCronJob } from "@/lib/cron/run";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Replay inbound messages that never got a delivered buyer reply.
 * pg_cron every 15 minutes.
 */
export async function POST(request: NextRequest) {
  return runCronJob(request, "pending-replay", async () => {
    const result = await runPendingReplay(createAdminClient());
    console.info("[cron/pending-replay] run complete", result);
    return result as unknown as Record<string, unknown>;
  });
}
