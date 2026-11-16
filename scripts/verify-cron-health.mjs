/**
 * Step 21d — cron health, auth heartbeats, backlog probe.
 * Stripe/Twilio: no real customer sends (mock numbers only if any).
 *
 *   node scripts/verify-cron-health.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const JOBS = [
  { name: "payment-chase", path: "/api/cron/payment-chase", schedule: "*/15 * * * *" },
  { name: "whatsapp-delivery-retry", path: "/api/cron/whatsapp-delivery-retry", schedule: "*/5 * * * *" },
  { name: "pending-replay", path: "/api/cron/pending-replay", schedule: "*/15 * * * *" },
  { name: "dispute-reminders", path: "/api/cron/dispute-reminders", schedule: "20 * * * *" },
  { name: "shop-purge", path: "/api/cron/shop-purge", schedule: "15 3 * * *" },
  { name: "low-stock-alerts", path: "/api/cron/low-stock-alerts", schedule: "0 8 * * *" },
  { name: "analytics-aggregate", path: "/api/cron/analytics-aggregate", schedule: "0 * * * *" },
];

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

const CRON_SECRET = env.CRON_SHARED_SECRET;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function postCron(path, secret) {
  const headers = { "Content-Type": "application/json" };
  if (secret != null) headers["x-cron-secret"] = secret;
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: "{}",
  });
  return {
    status: response.status,
    json: await response.json().catch(() => ({})),
  };
}

async function getHealth() {
  const response = await fetch(`${BASE}/api/health`, { method: "GET" });
  return {
    status: response.status,
    json: await response.json().catch(() => ({})),
  };
}

function looksLikeSecret(text) {
  if (!text) return false;
  const t = String(text);
  if (CRON_SECRET && t.includes(CRON_SECRET)) return true;
  if (/Bearer\s+[A-Za-z0-9._\-]{16,}/i.test(t)) return true;
  if (/sk_(live|test)_/i.test(t)) return true;
  return false;
}

async function backlogCounts() {
  const now = new Date();
  const counts = {};

  const { count: pendingReplay } = await admin
    .from("pending_replays")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .lte("next_attempt_at", now.toISOString());
  counts.pending_replay_due = pendingReplay ?? 0;

  const { count: deliveryRetry } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("delivery_status", "failed")
    .eq("direction", "outbound")
    .lte("next_retry_at", now.toISOString());
  counts.whatsapp_delivery_retry_due = deliveryRetry ?? 0;

  const { count: awaiting } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("status", "AWAITING_PAYMENT");
  counts.awaiting_payment_orders = awaiting ?? 0;

  // Rough due proxies for chase (age via status history is complex; count all awaiting).
  const { data: chaseCandidates } = await admin
    .from("orders")
    .select("id, payment_reminder_12h_sent_at, payment_reminder_23h_sent_at, created_at")
    .eq("status", "AWAITING_PAYMENT")
    .limit(200);
  const age12 = 12 * 3600 * 1000;
  const age23 = 23 * 3600 * 1000;
  const age24 = 24 * 3600 * 1000;
  let due12 = 0;
  let due23 = 0;
  let dueCancel = 0;
  for (const o of chaseCandidates ?? []) {
    const created = new Date(o.created_at).getTime();
    const age = Date.now() - created;
    if (age >= age12 && !o.payment_reminder_12h_sent_at) due12 += 1;
    if (age >= age23 && !o.payment_reminder_23h_sent_at) due23 += 1;
    if (age >= age24) dueCancel += 1;
  }
  counts.payment_chase_due_12h = due12;
  counts.payment_chase_due_23h = due23;
  counts.payment_chase_due_cancel = dueCancel;

  const { data: openDisputes } = await admin
    .from("disputes")
    .select(
      "id, evidence_due_by, evidence_status, reminder_5d_sent_at, reminder_2d_sent_at, reminder_1d_sent_at, accepted_at, evidence_submitted_at, amount_pence",
    )
    .is("closed_at", null)
    .in("evidence_status", ["draft", "ready"])
    .limit(200);
  let remDue = 0;
  let autoDue = 0;
  for (const d of openDisputes ?? []) {
    if (d.accepted_at || d.evidence_submitted_at) continue;
    if (!d.evidence_due_by) continue;
    const dueMs = new Date(d.evidence_due_by).getTime() - Date.now();
    const days = dueMs / 864e5;
    const hours = dueMs / 36e5;
    if (days <= 5 && !d.reminder_5d_sent_at) remDue += 1;
    else if (days <= 2 && !d.reminder_2d_sent_at) remDue += 1;
    else if (days <= 1 && hours > 24 && !d.reminder_1d_sent_at) remDue += 1;
    if (hours <= 24 && (d.amount_pence ?? 0) >= 4000) autoDue += 1;
  }
  counts.dispute_reminders_due = remDue;
  counts.dispute_autosubmit_window = autoDue;
  counts.open_disputes_actionable = (openDisputes ?? []).length;

  const { count: shopsDue } = await admin
    .from("businesses")
    .select("id", { count: "exact", head: true })
    .not("closed_at", "is", null)
    .is("deleted_at", null)
    .lte("purge_after", now.toISOString());
  counts.shop_purge_due = shopsDue ?? 0;

  // Templates / Shippo — no dedicated cron; report zero-job note.
  counts.template_cron_jobs = 0;
  counts.shippo_cron_jobs = 0;

  return counts;
}

async function main() {
  console.log("=== verify-cron-health (Step 21d) ===");
  console.log(`BASE=${BASE}`);
  console.log("\nCron routes + schedules:");
  for (const j of JOBS) {
    console.log(`  ${j.name.padEnd(28)} ${j.schedule.padEnd(14)} ${j.path}`);
  }

  if (!CRON_SECRET) {
    record("0. CRON_SHARED_SECRET present", false, "missing from env");
    process.exit(1);
  }
  record("0. CRON_SHARED_SECRET present (not printed)", true);

  // ---------- Backlog (read-only) ----------
  const before = await backlogCounts();
  console.log("\nBacklog counts (before cron sweep):");
  for (const [k, v] of Object.entries(before)) {
    console.log(`  ${k}=${v}`);
  }
  const sendishDue =
    (before.pending_replay_due ?? 0) +
    (before.whatsapp_delivery_retry_due ?? 0) +
    (before.payment_chase_due_12h ?? 0) +
    (before.payment_chase_due_23h ?? 0) +
    (before.dispute_reminders_due ?? 0);
  const burstRisk = sendishDue > 50;
  record(
    "backlog. no large real-send burst risk (test shops only)",
    !burstRisk,
    `sum_due_sendish=${sendishDue}`,
  );

  // Snapshot heartbeats to restore after stale test
  const { data: snapshot } = await admin
    .from("cron_heartbeats")
    .select("*");

  try {
    // ---------- Good calls (pg_cron style: x-cron-secret) ----------
    for (const job of JOBS) {
      const res = await postCron(job.path, CRON_SECRET);
      const { data: hb } = await admin
        .from("cron_heartbeats")
        .select("last_status, consecutive_failures, last_error_summary, last_success_at")
        .eq("job_name", job.name)
        .maybeSingle();
      const ok =
        res.status === 200 &&
        res.json?.ok === true &&
        hb?.last_status === "success" &&
        (hb?.consecutive_failures ?? 1) === 0;
      record(
        `1. ${job.name} → 200 + success heartbeat`,
        ok,
        `http=${res.status} status=${hb?.last_status} fails=${hb?.consecutive_failures}`,
      );
    }

    // ---------- Wrong secret ----------
    const probeJob = JOBS[0];
    const bad = await postCron(probeJob.path, "definitely-not-the-cron-secret");
    const { data: authHb } = await admin
      .from("cron_heartbeats")
      .select("last_status, consecutive_failures, last_error_summary")
      .eq("job_name", probeJob.name)
      .maybeSingle();
    record(
      "2. wrong secret → 401 + auth_failure heartbeat",
      bad.status === 401 && authHb?.last_status === "auth_failure",
      `http=${bad.status} status=${authHb?.last_status} summary=${authHb?.last_error_summary}`,
    );
    record(
      "2b. auth failure summary has no secret",
      !looksLikeSecret(authHb?.last_error_summary),
      `summary=${authHb?.last_error_summary}`,
    );

    // Restore probe job to success so health isn't stuck
    await postCron(probeJob.path, CRON_SECRET);

    // ---------- Stale → health degraded ----------
    const staleJob = "analytics-aggregate";
    const staleIso = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // 4h > 3*1h
    await admin
      .from("cron_heartbeats")
      .update({
        last_success_at: staleIso,
        last_status: "success",
        consecutive_failures: 0,
        last_error_summary: null,
        updated_at: new Date().toISOString(),
      })
      .eq("job_name", staleJob);

    const degraded = await getHealth();
    record(
      "3. overdue job → /api/health degraded (no details)",
      degraded.status === 503 &&
        degraded.json?.status === "degraded" &&
        !("jobs" in (degraded.json ?? {})) &&
        !("details" in (degraded.json ?? {})),
      `http=${degraded.status} body=${JSON.stringify(degraded.json)}`,
    );

    // ---------- Recovery ----------
    const recovered = await postCron("/api/cron/analytics-aggregate", CRON_SECRET);
    const healthOk = await getHealth();
    record(
      "4. after success → /api/health ok",
      recovered.status === 200 &&
        healthOk.status === 200 &&
        healthOk.json?.status === "ok",
      `cron=${recovered.status} health=${healthOk.status}`,
    );

    // ---------- Consecutive failures threshold ----------
    await admin
      .from("cron_heartbeats")
      .update({
        consecutive_failures: 3,
        last_status: "failure",
        last_error_summary: "verify_forced",
        updated_at: new Date().toISOString(),
      })
      .eq("job_name", "shop-purge");
    const failHealth = await getHealth();
    record(
      "5. consecutive_failures>=3 → degraded",
      failHealth.status === 503 && failHealth.json?.status === "degraded",
      `http=${failHealth.status}`,
    );
    await postCron("/api/cron/shop-purge", CRON_SECRET);
    const cleared = await getHealth();
    record(
      "5b. success clears failure streak → ok",
      cleared.status === 200 && cleared.json?.status === "ok",
      `http=${cleared.status}`,
    );

    // ---------- Heartbeats scrub ----------
    const { data: allHb } = await admin
      .from("cron_heartbeats")
      .select("job_name, last_error_summary, last_status");
    const dirty = (allHb ?? []).filter((r) => looksLikeSecret(r.last_error_summary));
    record(
      "6. no secrets in heartbeat rows",
      dirty.length === 0,
      dirty.length ? `dirty=${dirty.map((d) => d.job_name).join(",")}` : "clean",
    );

    // ---------- Backlog after sweep ----------
    const after = await backlogCounts();
    console.log("\nBacklog counts (after cron sweep):");
    for (const [k, v] of Object.entries(after)) {
      console.log(`  ${k}=${v}`);
    }
    record(
      "7. post-sweep backlog recorded",
      true,
      Object.entries(after)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    );
  } finally {
    // Restore any snapshot rows we may have left odd, then force success on all jobs.
    if (snapshot?.length) {
      for (const row of snapshot) {
        await admin.from("cron_heartbeats").upsert({
          job_name: row.job_name,
          last_started_at: row.last_started_at,
          last_success_at: row.last_success_at,
          last_status: row.last_status,
          last_error_summary: row.last_error_summary,
          consecutive_failures: row.consecutive_failures,
          updated_at: new Date().toISOString(),
        });
      }
    }
    // Leave jobs in a healthy success state from this verify run.
    for (const job of JOBS) {
      await postCron(job.path, CRON_SECRET);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed (of ${results.length}) ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
