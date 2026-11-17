import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CRON_CONSECUTIVE_FAILURE_THRESHOLD,
  CRON_JOBS,
  CRON_JOB_NAMES,
  cronNeverRanThresholdMs,
  cronOverdueThresholdMs,
  type CronJobName,
} from "@/lib/cron/jobs";
import { createAdminClient } from "@/lib/supabase/admin";

export type CronHeartbeatStatus =
  | "never"
  | "success"
  | "failure"
  | "auth_failure";

const SENTRY_AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const SENTRY_AUTH_FAIL_MIN_COUNT = 3;
/** Sliding window of auth-failure timestamps per job (Sentry only after 3). */
const authFailTimestamps = new Map<string, number[]>();

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
  runSummary?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const summary =
    runSummary != null ? safeCronErrorSummary(runSummary, 240) : null;
  const { error } = await supabase.from("cron_heartbeats").upsert(
    {
      job_name: jobName,
      last_started_at: now,
      last_success_at: now,
      last_status: "success",
      last_error_summary: null,
      last_run_summary: summary,
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
  // Always record every auth failure in the heartbeat.
  await markCronFailure(jobName, "unauthorized", "auth_failure");

  const now = Date.now();
  const prior = (authFailTimestamps.get(jobName) ?? []).filter(
    (ts) => now - ts < SENTRY_AUTH_FAIL_WINDOW_MS,
  );
  prior.push(now);
  authFailTimestamps.set(jobName, prior);

  // Sentry only after ≥3 failures for the same job within 15 minutes.
  if (prior.length < SENTRY_AUTH_FAIL_MIN_COUNT) {
    return;
  }
  // Emit at most once per window (when count first hits the threshold).
  if (prior.length !== SENTRY_AUTH_FAIL_MIN_COUNT) {
    return;
  }

  Sentry.captureException(new Error("cron_auth_failure"), {
    level: "error",
    tags: {
      cron_job: jobName,
      cron_auth: "failure",
    },
    extra: {
      jobName,
      reason: "unauthorized",
      failuresInWindow: prior.length,
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

/**
 * True when a job is overdue, over the failure threshold, or has never
 * succeeded after the never-ran grace since monitoring started.
 */
export function isCronJobStale(
  jobName: CronJobName,
  row: CronHealthRow | null | undefined,
  nowMs: number = Date.now(),
  monitoringStartedAtMs: number | null = null,
): boolean {
  const job = CRON_JOBS[jobName];
  const overdueMs = cronOverdueThresholdMs(job.intervalMs);
  const neverRanMs = cronNeverRanThresholdMs(job.intervalMs);

  if (
    row &&
    (row.consecutive_failures ?? 0) >= CRON_CONSECUTIVE_FAILURE_THRESHOLD
  ) {
    return true;
  }

  if (row?.last_success_at) {
    const age = nowMs - new Date(row.last_success_at).getTime();
    if (Number.isFinite(age) && age > overdueMs) return true;
    return false;
  }

  // Never succeeded (missing row, status never, or only started/failed).
  // Clock starts at monitoring_started_at (not ignored forever).
  if (monitoringStartedAtMs != null && Number.isFinite(monitoringStartedAtMs)) {
    const sinceStart = nowMs - monitoringStartedAtMs;
    if (Number.isFinite(sinceStart) && sinceStart > neverRanMs) {
      return true;
    }
  }

  // Fallback: a started-but-never-succeeded run past overdue threshold.
  if (row?.last_started_at) {
    const age = nowMs - new Date(row.last_started_at).getTime();
    if (Number.isFinite(age) && age > overdueMs) return true;
  }

  return false;
}

/** Singleton monitoring_started_at (ms), or null if unavailable. */
export async function getCronMonitoringStartedAtMs(
  supabase: SupabaseClient = createAdminClient(),
): Promise<number | null> {
  const { data, error } = await supabase
    .from("cron_monitoring_config")
    .select("monitoring_started_at")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error(
      "[cron/heartbeat] monitoring_started_at lookup failed",
      error.message,
    );
    return null;
  }
  if (!data?.monitoring_started_at) return null;
  const ms = new Date(data.monitoring_started_at as string).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export type CronDegradedReason =
  | "consecutive_failures"
  | "overdue"
  | "never_ran";

export type CronDegradedJob = {
  jobName: CronJobName;
  reason: CronDegradedReason;
};

/** List stale jobs with a coarse reason (no personal data). */
export function listDegradedCronJobs(
  rows: Map<string, CronHealthRow>,
  nowMs: number = Date.now(),
  monitoringStartedAtMs: number | null = null,
): CronDegradedJob[] {
  const out: CronDegradedJob[] = [];
  for (const name of CRON_JOB_NAMES) {
    const row = rows.get(name);
    if (!isCronJobStale(name, row, nowMs, monitoringStartedAtMs)) continue;

    let reason: CronDegradedReason = "never_ran";
    if (
      row &&
      (row.consecutive_failures ?? 0) >= CRON_CONSECUTIVE_FAILURE_THRESHOLD
    ) {
      reason = "consecutive_failures";
    } else if (row?.last_success_at) {
      reason = "overdue";
    } else {
      reason = "never_ran";
    }
    out.push({ jobName: name, reason });
  }
  return out;
}

/** True when any registered job is stale, never-ran past grace, or failing. */
export async function anyCronJobDegraded(
  supabase: SupabaseClient = createAdminClient(),
): Promise<boolean> {
  const degraded = await getDegradedCronJobs(supabase);
  return degraded.length > 0;
}

/** Fetch heartbeat rows and return degraded jobs (empty on lookup error). */
export async function getDegradedCronJobs(
  supabase: SupabaseClient = createAdminClient(),
): Promise<CronDegradedJob[]> {
  const [{ data, error }, monitoringStartedAtMs] = await Promise.all([
    supabase
      .from("cron_heartbeats")
      .select(
        "job_name, last_started_at, last_success_at, last_status, last_error_summary, consecutive_failures",
      )
      .in("job_name", CRON_JOB_NAMES),
    getCronMonitoringStartedAtMs(supabase),
  ]);

  if (error) {
    console.error("[cron/heartbeat] health lookup failed", error.message);
    // Fail open on lookup error — DB probe already covers connectivity.
    return [];
  }

  const byName = new Map(
    (data ?? []).map((row) => [row.job_name as string, row as CronHealthRow]),
  );
  return listDegradedCronJobs(byName, Date.now(), monitoringStartedAtMs);
}
