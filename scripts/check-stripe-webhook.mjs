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
  const hasAccountUpdated = receivesAll || ep.enabled_events.includes("account.updated");

  if (hasAccountUpdated) {
    console.log(
      receivesAll
        ? "\naccount.updated covered (endpoint receives all events '*')."
        : "\naccount.updated already registered — no change needed.",
    );
    return;
  }

  console.log("\naccount.updated NOT registered — adding it now…");
  const updated = await stripe.webhookEndpoints.update(ENDPOINT_ID, {
    enabled_events: [...ep.enabled_events, "account.updated"],
  });
  console.log(`Updated events: ${JSON.stringify(updated.enabled_events)}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
