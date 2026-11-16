import type { NextRequest } from "next/server";

import { runWhatsAppDeliveryRetry } from "@/lib/cron/whatsapp-delivery-retry";
import { runCronJob } from "@/lib/cron/run";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Retry failed outbound WhatsApp sends (rate limit / 5xx) with
 * minutes-scale backoff. Invoked by pg_cron every 5 minutes.
 */
export async function POST(request: NextRequest) {
  return runCronJob(request, "whatsapp-delivery-retry", async () => {
    const result = await runWhatsAppDeliveryRetry(createAdminClient());
    console.info("[cron/whatsapp-delivery-retry] run complete", result);
    return result as unknown as Record<string, unknown>;
  });
}
