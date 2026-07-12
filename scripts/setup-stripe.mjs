/**
 * One-off Stripe setup + verification for TradeFlow (test mode).
 *
 * Reads STRIPE_SECRET_KEY from .env.local and:
 *  1. Creates a webhook endpoint at the Vercel ingress URL (prints signing secret).
 *  2. Creates an Express connected account (prints acct id).
 *  3. Creates a hosted account-onboarding link.
 *  4. Creates a destination-charge PaymentIntent to that account.
 *
 * Run: node scripts/setup-stripe.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ??
  "https://tradeflow-tau-blush.vercel.app/api/webhooks/ingress";

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

async function main() {
  const account = await stripe.accounts.retrieve();
  console.log(`Stripe account: ${account.id} (${account.settings?.dashboard?.display_name ?? "TradeFlow"})`);
  console.log("");

  // 1. Webhook endpoint — skip if we already captured a signing secret to
  // avoid creating duplicate endpoints on re-runs.
  if (env.STRIPE_WEBHOOK_SECRET) {
    console.log("=== WEBHOOK ENDPOINT ===");
    console.log("Skipped — STRIPE_WEBHOOK_SECRET already configured.");
    console.log("");
  } else {
    const endpoint = await stripe.webhookEndpoints.create({
      url: WEBHOOK_URL,
      enabled_events: [
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "account.updated",
      ],
      description: "TradeFlow ingress (test)",
    });
    console.log("=== WEBHOOK ENDPOINT ===");
    console.log(`id:     ${endpoint.id}`);
    console.log(`url:    ${endpoint.url}`);
    console.log(`SECRET: ${endpoint.secret}`);
    console.log("");
  }

  // 2. Express connected account
  const connected = await stripe.accounts.create({
    type: "express",
    country: "GB",
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { tradeflow_business_id: "verify-script" },
  });
  console.log("=== CONNECTED ACCOUNT ===");
  console.log(`id: ${connected.id}`);
  console.log("");

  // 3. Account onboarding link
  const link = await stripe.accountLinks.create({
    account: connected.id,
    refresh_url: "https://tradeflow-tau-blush.vercel.app/onboarding",
    return_url: "https://tradeflow-tau-blush.vercel.app/dashboard",
    type: "account_onboarding",
  });
  console.log("=== ONBOARDING LINK ===");
  console.log(`url: ${link.url.slice(0, 60)}…`);
  console.log("");

  // 4. Destination-charge PaymentIntent
  const intent = await stripe.paymentIntents.create({
    amount: 2500,
    currency: "gbp",
    payment_method_types: ["card", "pay_by_bank"],
    transfer_data: { destination: connected.id },
    metadata: { tradeflow_order_ref: "TEST-ORDER" },
  });
  console.log("=== PAYMENT INTENT (destination charge) ===");
  console.log(`id:                  ${intent.id}`);
  console.log(`status:              ${intent.status}`);
  console.log(`amount:              ${intent.amount} ${intent.currency}`);
  console.log(`payment_method_types: ${JSON.stringify(intent.payment_method_types)}`);
  console.log(`transfer destination: ${intent.transfer_data?.destination}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
