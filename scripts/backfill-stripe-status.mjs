/**
 * Backfills stripe_charges_enabled / stripe_payouts_enabled /
 * stripe_details_submitted for every business that already has a
 * stripe_connected_account_id, by fetching live status from Stripe.
 *
 * Needed because the columns were added after connected accounts already
 * existed, so their values would otherwise be stale defaults (all FALSE)
 * until the next natural account.updated event.
 *
 * Run: node scripts/backfill-stripe-status.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-06-24.dahlia",
});
const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("id, name, stripe_connected_account_id")
    .not("stripe_connected_account_id", "is", null);

  if (error) {
    console.error("DB query failed:", error.message);
    process.exit(1);
  }

  if (!businesses.length) {
    console.log("No businesses with a connected account. Nothing to backfill.");
    return;
  }

  for (const business of businesses) {
    const acct = business.stripe_connected_account_id;
    try {
      const account = await stripe.accounts.retrieve(acct);
      const next = {
        stripe_charges_enabled: account.charges_enabled ?? false,
        stripe_payouts_enabled: account.payouts_enabled ?? false,
        stripe_details_submitted: account.details_submitted ?? false,
      };

      const { error: updateError } = await supabase
        .from("businesses")
        .update(next)
        .eq("id", business.id);

      if (updateError) {
        console.error(`  ${business.name} (${acct}): update failed — ${updateError.message}`);
        continue;
      }

      console.log(`✓ ${business.name} (${acct})`);
      console.log(`    charges_enabled:   ${next.stripe_charges_enabled}`);
      console.log(`    payouts_enabled:   ${next.stripe_payouts_enabled}`);
      console.log(`    details_submitted: ${next.stripe_details_submitted}`);
    } catch (err) {
      console.error(`  ${business.name} (${acct}): Stripe fetch failed — ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
