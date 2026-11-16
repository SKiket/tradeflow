/**
 * Operator-only cron heartbeat status (seller-invisible).
 *   node scripts/cron-status.mjs
 *
 * Prints job name, last success, consecutive failures, never-ran flag.
 * No secrets.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split(
    "\n",
  )) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return env;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MULTIPLIER = 3;
const DAILY_NEVER_RAN_MS = 26 * 60 * 60 * 1000;

const JOBS = {
  "payment-chase": { schedule: "*/15 * * * *", intervalMin: 15 },
  "whatsapp-delivery-retry": { schedule: "*/5 * * * *", intervalMin: 5 },
  "pending-replay": { schedule: "*/15 * * * *", intervalMin: 15 },
  "dispute-reminders": { schedule: "20 * * * *", intervalMin: 60 },
  "shop-purge": { schedule: "15 3 * * *", intervalMin: 1440 },
  "low-stock-alerts": { schedule: "0 8 * * *", intervalMin: 1440 },
  "analytics-aggregate": { schedule: "0 * * * *", intervalMin: 60 },
};

const env = loadEnv();
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function age(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function neverRanGraceMs(intervalMin) {
  const intervalMs = intervalMin * 60 * 1000;
  if (intervalMs >= DAY_MS) return DAILY_NEVER_RAN_MS;
  return intervalMs * MULTIPLIER;
}

const [{ data, error }, { data: cfg, error: cfgErr }] = await Promise.all([
  admin
    .from("cron_heartbeats")
    .select(
      "job_name, last_started_at, last_success_at, last_status, last_error_summary, consecutive_failures",
    )
    .order("job_name"),
  admin
    .from("cron_monitoring_config")
    .select("monitoring_started_at")
    .eq("id", 1)
    .maybeSingle(),
]);

if (error) {
  console.error("Failed to read cron_heartbeats:", error.message);
  process.exit(1);
}
if (cfgErr) {
  console.error("Failed to read cron_monitoring_config:", cfgErr.message);
  process.exit(1);
}

const byName = new Map((data ?? []).map((r) => [r.job_name, r]));
const monitoringStartedAt = cfg?.monitoring_started_at
  ? new Date(cfg.monitoring_started_at).getTime()
  : null;
const now = Date.now();

console.log("=== cron status ===");
if (monitoringStartedAt) {
  console.log(`monitoring_started_at: ${cfg.monitoring_started_at} (${age(cfg.monitoring_started_at)})`);
} else {
  console.log("monitoring_started_at: missing");
}
console.log(
  "job".padEnd(28),
  "schedule".padEnd(14),
  "status".padEnd(14),
  "last_success".padEnd(12),
  "fails".padEnd(6),
  "flag".padEnd(14),
  "error",
);

for (const [name, meta] of Object.entries(JOBS)) {
  const row = byName.get(name);
  const status = row?.last_status ?? "missing";
  const fails = String(row?.consecutive_failures ?? 0);
  const success = age(row?.last_success_at ?? null);
  const err = (row?.last_error_summary ?? "").slice(0, 40);

  let flag = "";
  const overdueMs = meta.intervalMin * 60 * 1000 * MULTIPLIER;
  const neverMs = neverRanGraceMs(meta.intervalMin);
  if ((row?.consecutive_failures ?? 0) >= 3) {
    flag = "FAILING";
  } else if (row?.last_success_at) {
    const a = now - new Date(row.last_success_at).getTime();
    if (a > overdueMs) flag = "OVERDUE";
  } else if (
    monitoringStartedAt != null &&
    now - monitoringStartedAt > neverMs
  ) {
    flag = "NEVER-RAN";
  } else if (!row?.last_success_at) {
    flag = "awaiting-first";
  }

  console.log(
    name.padEnd(28),
    meta.schedule.padEnd(14),
    status.padEnd(14),
    success.padEnd(12),
    fails.padEnd(6),
    flag.padEnd(14),
    err,
  );
}
