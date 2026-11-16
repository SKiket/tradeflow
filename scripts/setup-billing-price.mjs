/**
 * Idempotent Stripe Product + recurring Price for TradeFlow seller billing
 * (£19/month GBP on the PLATFORM account, not a Connect account).
 *
 * Also ensures the webhook endpoint listens for subscription events and
 * that a Billing Portal configuration exists.
 *
 * Run: node scripts/setup-billing-price.mjs
 *
 * Writes STRIPE_SUBSCRIPTION_PRICE_ID into .env.local (set the same in Vercel).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_METADATA_KEY = "tradeflow";
const PRODUCT_METADATA_VALUE = "seller-subscription";
const PRICE_AMOUNT_PENCE = 1900;
const ENDPOINT_ID = process.env.ENDPOINT_ID ?? "we_1TsMXqDQdP6fmgysHjjYQ4uE";
const SUBSCRIPTION_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
];

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, eq)] = value;
  }
  return env;
}

function upsertEnvVar(key, value) {
  const envPath = resolve(root, ".env.local");
  const existing = readFileSync(envPath, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(existing)
    ? existing.replace(re, line)
    : `${existing.replace(/\s*$/, "")}\n${line}\n`;
  writeFileSync(envPath, next);
}

const env = loadEnv();
if (!env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY missing from .env.local");
  process.exit(1);
}

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-06-24.dahlia",
});

async function findProduct() {
  for await (const product of stripe.products.list({ limit: 100, active: true })) {
    if (product.metadata?.[PRODUCT_METADATA_KEY] === PRODUCT_METADATA_VALUE) {
      return product;
    }
  }
  return null;
}

async function findMonthlyPrice(productId, amountPence) {
  for await (const price of stripe.prices.list({
    product: productId,
    active: true,
    limit: 100,
  })) {
    if (
      price.currency === "gbp" &&
      price.unit_amount === amountPence &&
      price.recurring?.interval === "month" &&
      price.recurring?.interval_count === 1
    ) {
      return price;
    }
  }
  return null;
}

async function main() {
  const account = await stripe.accounts.retrieve();
  console.log(
    `Platform account: ${account.id} (${account.settings?.dashboard?.display_name ?? "TradeFlow"})`,
  );

  let product = await findProduct();
  if (product) {
    console.log(`Product exists: ${product.id} (${product.name})`);
    await stripe.products.update(product.id, {
      description:
        "TradeFlow seller subscription — £19/month plus 4.5% + 20p per order paid through TradeFlow.",
    });
  } else {
    product = await stripe.products.create({
      name: "TradeFlow",
      description:
        "TradeFlow seller subscription — £19/month plus 4.5% + 20p per order paid through TradeFlow.",
      metadata: { [PRODUCT_METADATA_KEY]: PRODUCT_METADATA_VALUE },
    });
    console.log(`Product created: ${product.id}`);
  }

  // List existing active monthly prices (do not alter old subscriptions).
  const existingPrices = [];
  for await (const price of stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  })) {
    if (price.recurring?.interval === "month") {
      existingPrices.push(price);
    }
  }
  console.log("Existing active monthly prices (unchanged for current subs):");
  for (const p of existingPrices) {
    console.log(
      `  ${p.id} amount=${p.unit_amount} ${p.currency} created=${new Date(p.created * 1000).toISOString()}`,
    );
  }

  let price = await findMonthlyPrice(product.id, PRICE_AMOUNT_PENCE);
  if (price) {
    console.log(
      `£19 Price exists: ${price.id} (${price.unit_amount} ${price.currency}/${price.recurring.interval})`,
    );
  } else {
    price = await stripe.prices.create({
      product: product.id,
      currency: "gbp",
      unit_amount: PRICE_AMOUNT_PENCE,
      recurring: { interval: "month" },
      metadata: {
        [PRODUCT_METADATA_KEY]: PRODUCT_METADATA_VALUE,
        monthly_fee_pence: String(PRICE_AMOUNT_PENCE),
      },
    });
    console.log(`£19 Price created: ${price.id}`);
  }

  upsertEnvVar("STRIPE_SUBSCRIPTION_PRICE_ID", price.id);
  console.log(`Wrote STRIPE_SUBSCRIPTION_PRICE_ID=${price.id} to .env.local`);
  console.log(
    "Set the same STRIPE_SUBSCRIPTION_PRICE_ID in Vercel (Production).",
  );

  // List existing test subscriptions on this price / product (do not alter).
  const subs = await stripe.subscriptions.list({
    price: price.id,
    status: "all",
    limit: 20,
  });
  console.log(`\nSubscriptions on new £19 price (${subs.data.length}):`);
  for (const s of subs.data) {
    console.log(`  ${s.id} status=${s.status} customer=${s.customer}`);
  }

  // Also list any still on the old £10 price if present.
  const oldTen = existingPrices.find((p) => p.unit_amount === 1000);
  if (oldTen) {
    const oldSubs = await stripe.subscriptions.list({
      price: oldTen.id,
      status: "all",
      limit: 50,
    });
    console.log(
      `\nExisting subscriptions still on £10 price ${oldTen.id} (not altered): ${oldSubs.data.length}`,
    );
    for (const s of oldSubs.data) {
      console.log(`  ${s.id} status=${s.status} customer=${s.customer}`);
    }
  }

  const configs = await stripe.billingPortal.configurations.list({
    limit: 5,
    active: true,
  });
  if (configs.data.length === 0) {
    const config = await stripe.billingPortal.configurations.create({
      business_profile: { headline: "TradeFlow billing" },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ["email"] },
      },
    });
    console.log(`Billing Portal configuration created: ${config.id}`);
  } else {
    console.log(`Billing Portal configuration exists: ${configs.data[0].id}`);
  }

  try {
    const endpoint = await stripe.webhookEndpoints.retrieve(ENDPOINT_ID);
    const missing = SUBSCRIPTION_EVENTS.filter(
      (eventName) =>
        !endpoint.enabled_events.includes("*") &&
        !endpoint.enabled_events.includes(eventName),
    );
    if (missing.length === 0) {
      console.log("Webhook already includes subscription events.");
    } else {
      const updated = await stripe.webhookEndpoints.update(ENDPOINT_ID, {
        enabled_events: [...new Set([...endpoint.enabled_events, ...missing])],
      });
      console.log(`Webhook events added: ${missing.join(", ")}`);
      console.log(`Enabled: ${JSON.stringify(updated.enabled_events)}`);
    }
  } catch (error) {
    console.warn(
      `Could not update webhook ${ENDPOINT_ID}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log("\n=== RESULT ===");
  console.log(`STRIPE_PRODUCT_ID=${product.id}`);
  console.log(`STRIPE_SUBSCRIPTION_PRICE_ID=${price.id}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
