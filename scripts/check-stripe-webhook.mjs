/**
 * Inspects the TradeFlow Stripe webhook endpoint and ensures account.updated
 * is registered. Run: node scripts/check-stripe-webhook.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT_ID = process.env.ENDPOINT_ID ?? "we_1TsMXqDQdP6fmgysHjjYQ4uE";

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

async function main() {
  const ep = await stripe.webhookEndpoints.retrieve(ENDPOINT_ID);
  console.log(`Endpoint: ${ep.id}`);
  console.log(`URL:      ${ep.url}`);
  console.log(`Status:   ${ep.status}`);
  console.log(`Events:   ${JSON.stringify(ep.enabled_events)}`);

  const receivesAll = ep.enabled_events.includes("*");
  const required = [
    "account.updated",
    "payment_intent.payment_failed",
    "checkout.session.expired",
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "refund.updated",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_failed",
  ];
  const missing = receivesAll
    ? []
    : required.filter((e) => !ep.enabled_events.includes(e));

  if (missing.length === 0) {
    console.log(
      receivesAll
        ? "\nAll required events covered (endpoint receives '*')."
        : "\nAll required events already registered — no change needed.",
    );
    return;
  }

  console.log(`\nMissing events: ${JSON.stringify(missing)} — adding now…`);
  const updated = await stripe.webhookEndpoints.update(ENDPOINT_ID, {
    enabled_events: [...new Set([...ep.enabled_events, ...missing])],
  });
  console.log(`Updated events: ${JSON.stringify(updated.enabled_events)}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
