/**
 * Verifies destination-charge PaymentIntent creation (test mode).
 *
 * Prefers the pilot shop's connected account when transfers is already active.
 * Otherwise creates a Custom test account with card_payments + transfers and
 * tos_acceptance, then retries until transfers is active (or fails clearly).
 *
 * Run: node scripts/verify-payment-intent.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

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
const secretKey = env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error("STRIPE_SECRET_KEY missing from .env.local");
  process.exit(1);
}

const stripe = new Stripe(secretKey, { apiVersion: "2026-06-24.dahlia" });
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createOnboardedCustomAccount() {
  const account = await stripe.accounts.create({
    type: "custom",
    country: "GB",
    email: `seller-verify-${Date.now()}@example.com`,
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      mcc: "5734",
      product_description: "TradeFlow test seller",
      url: "https://tradeflow-tau-blush.vercel.app",
    },
    individual: {
      first_name: "Test",
      last_name: "Seller",
      email: "seller-verify@example.com",
      phone: "+447000000000",
      dob: { day: 1, month: 1, year: 1990 },
      address: {
        line1: "10 Downing Street",
        city: "London",
        postal_code: "SW1A 2AA",
        country: "GB",
      },
    },
    external_account: {
      object: "bank_account",
      country: "GB",
      currency: "gbp",
      account_holder_name: "Test Seller",
      account_holder_type: "individual",
      routing_number: "108800",
      account_number: "00012345",
    },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    metadata: { tradeflow_business_id: "verify-payment-script" },
  });

  // Request capabilities again if still pending (idempotent).
  try {
    await stripe.accounts.update(account.id, {
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
  } catch {
    /* ignore */
  }

  for (let i = 0; i < 8; i++) {
    const refreshed = await stripe.accounts.retrieve(account.id);
    if (refreshed.capabilities?.transfers === "active") return refreshed;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return stripe.accounts.retrieve(account.id);
}

async function main() {
  let destinationId = null;

  const { data: pilot } = await admin
    .from("businesses")
    .select("stripe_connected_account_id, stripe_transfers_capability_active")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();

  if (pilot?.stripe_connected_account_id) {
    const live = await stripe.accounts.retrieve(pilot.stripe_connected_account_id);
    if (live.capabilities?.transfers === "active") {
      destinationId = live.id;
      console.log(`Using pilot Connect account ${destinationId} (transfers active)`);
    }
  }

  if (!destinationId) {
    console.log("Creating onboarded Custom test account…");
    const account = await createOnboardedCustomAccount();
    destinationId = account.id;
    console.log("=== CONNECTED ACCOUNT (verification) ===");
    console.log(`id:                 ${account.id}`);
    console.log(`transfers capability: ${account.capabilities?.transfers}`);
    console.log(`charges_enabled:      ${account.charges_enabled}`);
    if (account.capabilities?.transfers !== "active") {
      console.error(
        "FAILED: transfers capability not active on new test account — complete Stripe test onboarding or use a ready account",
      );
      process.exit(1);
    }
  }

  const intent = await stripe.paymentIntents.create({
    amount: 2500,
    currency: "gbp",
    payment_method_types: ["card", "pay_by_bank"],
    transfer_data: { destination: destinationId },
    metadata: { tradeflow_order_ref: "TEST-ORDER" },
  });

  console.log("=== PAYMENT INTENT (destination charge) ===");
  console.log(`id:                   ${intent.id}`);
  console.log(`status:               ${intent.status}`);
  console.log(`amount:               ${intent.amount} ${intent.currency}`);
  console.log(`payment_method_types: ${JSON.stringify(intent.payment_method_types)}`);
  console.log(`transfer destination: ${intent.transfer_data?.destination}`);

  const ok =
    intent.id &&
    intent.payment_method_types.includes("card") &&
    intent.payment_method_types.includes("pay_by_bank") &&
    intent.transfer_data?.destination === destinationId;
  console.log("");
  console.log(ok ? "PASS — destination-charge PaymentIntent created" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
