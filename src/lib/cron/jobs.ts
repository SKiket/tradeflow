/**
 * Canonical cron job registry: path, expected interval, human label.
 * Intervals match pg_cron schedules (see supabase migrations / schedule_*.sql).
 */
export const CRON_JOBS = {
  "payment-chase": {
    path: "/api/cron/payment-chase",
    // every 15 minutes
    intervalMs: 15 * 60 * 1000,
    schedule: "*/15 * * * *",
  },
  "whatsapp-delivery-retry": {
    path: "/api/cron/whatsapp-delivery-retry",
    // every 5 minutes
    intervalMs: 5 * 60 * 1000,
    schedule: "*/5 * * * *",
  },
  "pending-replay": {
    path: "/api/cron/pending-replay",
    // every 15 minutes
    intervalMs: 15 * 60 * 1000,
    schedule: "*/15 * * * *",
  },
  "dispute-reminders": {
    path: "/api/cron/dispute-reminders",
    // hourly at :20
    intervalMs: 60 * 60 * 1000,
    schedule: "20 * * * *",
  },
  "shop-purge": {
    path: "/api/cron/shop-purge",
    // daily 03:15 UTC
    intervalMs: 24 * 60 * 60 * 1000,
    schedule: "15 3 * * *",
  },
  "low-stock-alerts": {
    path: "/api/cron/low-stock-alerts",
    // daily 08:00 UTC
    intervalMs: 24 * 60 * 60 * 1000,
    schedule: "0 8 * * *",
  },
  "analytics-aggregate": {
    path: "/api/cron/analytics-aggregate",
    // hourly
    intervalMs: 60 * 60 * 1000,
    schedule: "0 * * * *",
  },
} as const;

export type CronJobName = keyof typeof CRON_JOBS;

export const CRON_JOB_NAMES = Object.keys(CRON_JOBS) as CronJobName[];

/** Health degrades when last success is older than this many intervals. */
export const CRON_STALE_INTERVAL_MULTIPLIER = 3;

export const CRON_CONSECUTIVE_FAILURE_THRESHOLD = 3;
