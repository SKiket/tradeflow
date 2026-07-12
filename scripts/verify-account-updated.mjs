/**
 * Verifies the account.updated webhook sync end to end (test mode).
 *
 *  1. Sends a locally-signed account.updated event for the real connected
 *     account with all-true capabilities → confirms the business row updates
 *     and the transition is applied.
 *  2. Sends one for an account id that matches no business → confirms 200 with
 *     no error (not a 500).
 *  3. Restores the row to Stripe's true current status via the backfill logic.
 *
 * Requires the dev server on localhost:3000. Run:
 *   node scripts/verify-account-updated.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" });
const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function signStripe(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function accountUpdatedEvent(accountId, caps) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type: "account.updated",
    data: {
      object: {
        id: accountId,
        object: "account",
        charges_enabled: caps.charges,
        payouts_enabled: caps.payouts,
        details_submitted: caps.details,
      },
    },
  });
}

async function post(payload) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signStripe(payload),
    },
    body: payload,
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function main() {
  const { data: business } = await supabase
    .from("businesses")
    .select("id, name, stripe_connected_account_id")
    .not("stripe_connected_account_id", "is", null)
    .limit(1)
    .maybeSingle();

  if (!business) {
    console.error("No business with a connected account to test against.");
    process.exit(1);
  }
  const acct = business.stripe_connected_account_id;
  console.log(`Testing against ${business.name} (${acct})\n`);

  // --- Test 1: matching account, all-true ---
  const evt1 = accountUpdatedEvent(acct, { charges: true, payouts: true, details: true });
  const res1 = await post(evt1);
  const { data: after1 } = await supabase
    .from("businesses")
    .select("stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted")
    .eq("id", business.id)
    .single();
  const pass1 =
    res1.status === 200 &&
    res1.json.handled === true &&
    after1.stripe_charges_enabled === true &&
    after1.stripe_payouts_enabled === true &&
    after1.stripe_details_submitted === true;
  console.log(`${pass1 ? "PASS" : "FAIL"} — Test 1: matching account.updated syncs columns`);
  console.log(`       response=${JSON.stringify(res1.json)}`);
  console.log(`       row now=${JSON.stringify(after1)}`);

  // --- Test 2: unknown account → 200, no error ---
  const evt2 = accountUpdatedEvent("acct_DOESNOTEXIST0000", { charges: true, payouts: true, details: true });
  const res2 = await post(evt2);
  const pass2 =
    res2.status === 200 &&
    res2.json.handled === false &&
    res2.json.reason === "no_matching_business";
  console.log(`\n${pass2 ? "PASS" : "FAIL"} — Test 2: unknown account → 200, logged, not 500`);
  console.log(`       response=${JSON.stringify(res2.json)}`);

  // --- Restore true Stripe status ---
  const account = await stripe.accounts.retrieve(acct);
  await supabase
    .from("businesses")
    .update({
      stripe_charges_enabled: account.charges_enabled ?? false,
      stripe_payouts_enabled: account.payouts_enabled ?? false,
      stripe_details_submitted: account.details_submitted ?? false,
    })
    .eq("id", business.id);
  console.log(`\nRestored ${business.name} to true Stripe status:`);
  console.log(`  charges_enabled=${account.charges_enabled} payouts_enabled=${account.payouts_enabled} details_submitted=${account.details_submitted}`);

  process.exit(pass1 && pass2 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
