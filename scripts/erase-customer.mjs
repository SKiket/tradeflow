/**
 * Operator customer erasure (email requests to TradeFlow).
 *
 *   node scripts/erase-customer.mjs --business=<slug> --phone=<E164> [--dry-run]
 *
 * Dry-run prints counts only — no personal data.
 * Uses service role. No real Twilio required (redaction is best-effort).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, eq)] = v;
  }
  return env;
}

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const dryRun = process.argv.includes("--dry-run");
const slug = arg("business");
const phone = arg("phone");

if (!slug || !phone) {
  console.error("Usage: node scripts/erase-customer.mjs --business=<slug> --phone=<E164> [--dry-run]");
  process.exit(1);
}

const fileEnv = loadEnv();
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] == null) process.env[k] = v;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing Supabase env");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: business, error: bizError } = await admin
  .from("businesses")
  .select("id, slug")
  .eq("slug", slug)
  .is("deleted_at", null)
  .maybeSingle();

if (bizError || !business) {
  console.error("Business not found for slug (no personal data logged)");
  process.exit(1);
}

const { data: customer, error: custError } = await admin
  .from("customers")
  .select("id, deleted_at")
  .eq("business_id", business.id)
  .eq("phone_e164", phone)
  .maybeSingle();

if (custError || !customer) {
  console.error("Customer not found for that shop+phone");
  process.exit(1);
}

const { count: messageCount } = await admin
  .from("messages")
  .select("id", { count: "exact", head: true })
  .eq("business_id", business.id)
  .eq("customer_id", customer.id);

const { count: orderCount } = await admin
  .from("orders")
  .select("id", { count: "exact", head: true })
  .eq("business_id", business.id)
  .eq("customer_id", customer.id);

const { count: replayCount } = await admin
  .from("pending_replays")
  .select("id", { count: "exact", head: true })
  .eq("business_id", business.id)
  .eq("customer_id", customer.id);

console.log("Dry-run preview (counts only):", {
  businessId: business.id,
  customerId: customer.id,
  alreadyDeleted: Boolean(customer.deleted_at),
  messages: messageCount ?? 0,
  orders: orderCount ?? 0,
  pendingReplays: replayCount ?? 0,
});

if (dryRun) {
  console.log("DRY-RUN — no changes made");
  process.exit(0);
}

// Delegate to TypeScript eraseCustomer via tsx for full behaviour.
const runner = resolve(root, "scripts/_erase-customer-run.mts");
const result = spawnSync(
  "npx",
  ["--yes", "tsx", runner, business.id, customer.id],
  { cwd: root, encoding: "utf8", shell: true },
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
