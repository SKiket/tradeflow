/**
 * Step 19b — purge cap + cron privilege checks (no real Twilio).
 *
 *   npx --yes tsx scripts/verify-step19b.mts
 */
import { PURGE_MAX_SHOPS_PER_RUN } from "../src/lib/privacy/constants.ts";
import { purgeDueShops } from "../src/lib/privacy/shop-lifecycle.ts";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  let v = t.slice(eq + 1);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  const k = t.slice(0, eq);
  if (process.env[k] == null) process.env[k] = v;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

assert(PURGE_MAX_SHOPS_PER_RUN === 5, "PURGE_MAX_SHOPS_PER_RUN is 5");

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const summary = await purgeDueShops(admin, { dryRun: true });
assert(typeof summary.dueTotal === "number", "dueTotal present");
assert(typeof summary.remaining === "number", "remaining present");
assert(typeof summary.processed === "number", "processed present");
assert(
  summary.processed <= PURGE_MAX_SHOPS_PER_RUN,
  "processed capped at PURGE_MAX_SHOPS_PER_RUN",
);
assert(
  summary.remaining === Math.max(0, summary.dueTotal - summary.processed),
  "remaining = dueTotal - processed",
);
console.log("OK purgeDueShops dry-run cap", {
  dueTotal: summary.dueTotal,
  processed: summary.processed,
  remaining: summary.remaining,
  max: PURGE_MAX_SHOPS_PER_RUN,
});

const anon = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const cronRpc = await anon.rpc("invoke_app_cron", {
  p_path: "/api/cron/payment-chase",
});
assert(cronRpc.error, "anon invoke_app_cron must error");
assert(
  /permission denied|not authorized|42501/i.test(cronRpc.error!.message),
  `anon denied: ${cronRpc.error!.message}`,
);
console.log("OK anon RPC invoke_app_cron denied:", cronRpc.error!.message);

console.log("\nALL STEP 19b CHECKS PASSED");
