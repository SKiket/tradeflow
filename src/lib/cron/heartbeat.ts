import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CRON_CONSECUTIVE_FAILURE_THRESHOLD,
  CRON_JOBS,
  CRON_JOB_NAMES,
  CRON_STALE_INTERVAL_MULTIPLIER,
  type CronJobName,
} from "@/lib/cron/jobs";
import { createAdminClient } from "@/lib/supabase/admin";

export type CronHeartbeatStatus =
  | "never"
  | "success"
  | "failure"
  | "auth_failure";

const SENTRY_AUTH_FAIL_MIN_INTERVAL_MS = 15 * 60 * 1000;
const lastAuthFailSentryAt = new Map<string, number>();

/** Strip anything that might look like a secret or PII from error summaries. */
export function safeCronErrorSummary(
  reason: string | null | undefined,
  maxLen = 180,
): string | null {
  if (!reason) return null;
  let text = String(reason)
    .replace(
      /Bearer\s+[A-Za-z0-9._\-]+/gi,
      "Bearer [redacted]",
    )
    .replace(
      /(?:secret|token|password|authorization)\s*[:=]\s*\S+/gi,
      "[redacted]",
    )
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1)}…`;
  return text;
}

export async function markCronStarted(
  jobName: CronJobName,
  supabase: SupabaseClient = createAdminClient(),
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("cron_heartbeats").upsert(
    {
      job_name: jobName,
      last_started_at: now,
      updated_at: now,
    },
    { onConflict: "job_name" },
  );
  if (error) {
    console.error("[cron/heartbeat] mark started failed", {
      jobName,
      message: error.message,
    });
  }
}

export async function markCronSuccess(
  jobName: CronJobName,
  supabase: SupabaseClient = createAdminClient(),
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("cron_heartbeats").upsert(
    {
      job_name: jobName,
      last_started_at: now,
      last_success_at: now,
      last_status: "success",
      last_error_summary: null,
      consecutive_failures: 0,
      updated_at: now,
    },
    { onConflict: "job_name" },
  );
  if (error) {
    console.error("[cron/heartbeat] mark success failed", {
      jobName,
      message: error.message,
    });
  }
}

export async function markCronFailure(
  jobName: CronJobName,
  reason: string,
  status: Extract<CronHeartbeatStatus, "failure" | "auth_failure"> = "failure",
  supabase: SupabaseClient = createAdminClient(),
): Promise<void> {
  const now = new Date().toISOString();
  const summary = safeCronErrorSummary(reason) ?? status;

  const { data: existing } = await supabase
    .from("cron_heartbeats")
    .select("consecutive_failures")
    .eq("job_name", jobName)
    .maybeSingle();

  const consecutive =
    ((existing?.consecutive_failures as number | null) ?? 0) + 1;

  const { error } = await supabase.from("cron_heartbeats").upsert(
    {
      job_name: jobName,
      last_started_at: now,
      last_status: status,
      last_error_summary: summary,
      consecutive_failures: consecutive,
      updated_at: now,
    },
    { onConflict: "job_name" },
  );
  if (error) {
    console.error("[cron/heartbeat] mark failure failed", {
      jobName,
      message: error.message,
    });
  }
}

/**
 * Record an auth failure heartbeat and rate-limited Sentry error.
 * Never includes the presented secret or request body.
 */
export async function recordCronAuthFailure(
  jobName: CronJobName,
): Promise<void> {
  await markCronFailure(jobName, "unauthorized", "auth_failure");

  const now = Date.now();
  const last = lastAuthFailSentryAt.get(jobName) ?? 0;
  if (now - last < SENTRY_AUTH_FAIL_MIN_INTERVAL_MS) {
    return;
  }
  lastAuthFailSentryAt.set(jobName, now);

  Sentry.captureException(new Error("cron_auth_failure"), {
    level: "error",
    tags: {
      cron_job: jobName,
      cron_auth: "failure",
    },
    extra: {
      jobName,
      reason: "unauthorized",
      // Explicitly omit request body, headers, and secret material.
    },
  });
}

export type CronHealthRow = {
  job_name: string;
  last_started_at: string | null;
  last_success_at: string | null;
  last_status: string;
  last_error_summary: string | null;
  consecutive_failures: number;
};

export function isCronJobStale(
  jobName: CronJobName,
  row: CronHealthRow | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const job = CRON_JOBS[jobName];
  const thresholdMs = job.intervalMs * CRON_STALE_INTERVAL_MULTIPLIER;

  if (!row) return false;

  if (
    (row.consecutive_failures ?? 0) >= CRON_CONSECUTIVE_FAILURE_THRESHOLD
  ) {
    return true;
  }

  if (row.last_success_at) {
    const age = nowMs - new Date(row.last_success_at).getTime();
    if (Number.isFinite(age) && age > thresholdMs) return true;
    return false;
  }

  // Never succeeded: only stale once a run has started and enough time passed.
  if (row.last_started_at) {
    const age = nowMs - new Date(row.last_started_at).getTime();
    if (Number.isFinite(age) && age > thresholdMs) return true;
  }

  return false;
}

/** True when any registered job is stale or over the failure threshold. */
export async function anyCronJobDegraded(
  supabase: SupabaseClient = createAdminClient(),
): Promise<boolean> {
  const { data, error } = await supabase
    .from("cron_heartbeats")
    .select(
      "job_name, last_started_at, last_success_at, last_status, last_error_summary, consecutive_failures",
    )
    .in("job_name", CRON_JOB_NAMES);

  if (error) {
    console.error("[cron/heartbeat] health lookup failed", error.message);
    // Fail open on lookup error — DB probe already covers connectivity.
    return false;
  }

  const byName = new Map(
    (data ?? []).map((row) => [row.job_name as string, row as CronHealthRow]),
  );

  for (const name of CRON_JOB_NAMES) {
    if (isCronJobStale(name, byName.get(name))) return true;
  }
  return false;
}
