import { NextResponse, type NextRequest } from "next/server";

import { authorizeCronRequest } from "@/lib/cron/auth";
import {
  markCronFailure,
  markCronStarted,
  markCronSuccess,
  recordCronAuthFailure,
  safeCronErrorSummary,
} from "@/lib/cron/heartbeat";
import type { CronJobName } from "@/lib/cron/jobs";

/**
 * Shared cron route wrapper: auth → heartbeat start → handler → success/failure.
 * Auth failures are recorded (no secret) and reported to Sentry rate-limited.
 */
export async function runCronJob(
  request: NextRequest,
  jobName: CronJobName,
  handler: () => Promise<Record<string, unknown> | void>,
): Promise<NextResponse> {
  if (!(await authorizeCronRequest(request))) {
    await recordCronAuthFailure(jobName);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await markCronStarted(jobName);

  try {
    const result = await handler();
    await markCronSuccess(jobName);
    return NextResponse.json({ ok: true, ...(result ?? {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safe = safeCronErrorSummary(message) ?? "handler_error";
    console.error(`[cron/${jobName}] failed`, { message: safe });
    await markCronFailure(jobName, safe, "failure");
    return NextResponse.json({ ok: false, error: safe }, { status: 500 });
  }
}
