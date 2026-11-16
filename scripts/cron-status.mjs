/**
 * Operator-only cron heartbeat status (seller-invisible).
 *   node scripts/cron-status.mjs
 *
 * Prints job name, last success, consecutive failures. No secrets.
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

const { data, error } = await admin
  .from("cron_heartbeats")
  .select(
    "job_name, last_started_at, last_success_at, last_status, last_error_summary, consecutive_failures",
  )
  .order("job_name");

if (error) {
  console.error("Failed to read cron_heartbeats:", error.message);
  process.exit(1);
}

const byName = new Map((data ?? []).map((r) => [r.job_name, r]));

console.log("=== cron status ===");
console.log(
  "job".padEnd(28),
  "schedule".padEnd(14),
  "status".padEnd(14),
  "last_success".padEnd(12),
  "fails".padEnd(6),
  "error",
);

for (const [name, meta] of Object.entries(JOBS)) {
  const row = byName.get(name);
  const status = row?.last_status ?? "missing";
  const fails = String(row?.consecutive_failures ?? 0);
  const success = age(row?.last_success_at ?? null);
  const err = (row?.last_error_summary ?? "").slice(0, 40);
  console.log(
    name.padEnd(28),
    meta.schedule.padEnd(14),
    status.padEnd(14),
    success.padEnd(12),
    fails.padEnd(6),
    err,
  );
}
