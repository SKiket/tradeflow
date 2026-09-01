/**
 * One-shot backfill: every existing business with stripe_customer_id IS NULL
 * gets a real Stripe Customer + 30-day trial Subscription (B1 price, no card).
 *
 * stripe_subscription_status / trial_ends_at are NOT written here — the B1
 * webhook (customer.subscription.created) is the source of truth. The
 * customer id is saved first so that webhook can look the business up.
 *
 * These backfilled trials have NO payment method. They will not convert
 * automatically at trial end (trial_settings.end_behavior = cancel). That
 * is expected for pre-existing test data, not a bug to fix here.
 *
 * Run (dev server on :3000 so the webhook path is live):
 *   node scripts/backfill-seller-trials.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const WEBHOOK = `${BASE}/api/webhooks/ingress`;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1);
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, eq)] = v;
  }
  return env;
}

function canAcceptOrders(business) {
  const status = business?.stripe_subscription_status;
  return status === "trialing" || status === "active";
}

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-06-24.dahlia",
});
const PRICE_ID = env.STRIPE_SUBSCRIPTION_PRICE_ID;
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;

function signStripe(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function postStripeEvent(payload) {
  const response = await fetch(WEBHOOK, {
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

function subscriptionEvent(type, subscription) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    data: { object: subscription },
  });
}

async function ownerEmail(userId) {
  if (!userId) return null;
  const { data } = await admin.auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}

async function main() {
  if (!PRICE_ID) throw new Error("STRIPE_SUBSCRIPTION_PRICE_ID missing");
  if (!WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET missing");

  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`Dev server not reachable at ${BASE} — webhook path must be live`);
  }

  console.log(`BASE ${BASE}`);
  console.log(`PRICE ${PRICE_ID}`);
  console.log("");
  console.log(
    "FLAG: backfilled trials have NO payment method attached.",
  );
  console.log(
    "They will fail to convert automatically at trial end (Stripe will cancel).",
  );
  console.log(
    "Expected for pre-existing test data — not a bug to fix in this step.",
  );
  console.log("");

  const { data: businesses, error } = await admin
    .from("businesses")
    .select(
      "id, name, slug, owner_user_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, trial_ends_at",
    )
    .is("deleted_at", null)
    .is("stripe_customer_id", null)
    .order("name", { ascending: true });

  if (error) throw new Error(error.message);

  const rows = businesses ?? [];
  console.log(`Businesses with stripe_customer_id IS NULL: ${rows.length}`);

  const results = [];
  for (const business of rows) {
    const result = {
      id: business.id,
      name: business.name,
      slug: business.slug,
      customerId: null,
      subscriptionId: null,
      webhookHandled: false,
      status: null,
      trialEndsAt: null,
      canAccept: false,
      error: null,
    };
    try {
      const email =
        (await ownerEmail(business.owner_user_id)) ??
        `backfill-${business.id.slice(0, 8)}@tradeflow-test.local`;

      const customer = await stripe.customers.create({
        email,
        name: business.name ?? undefined,
        metadata: {
          tradeflow_business_id: business.id,
          backfill: "preexisting-no-pm",
        },
      });

      const { error: saveError } = await admin
        .from("businesses")
        .update({ stripe_customer_id: customer.id })
        .eq("id", business.id);
      if (saveError) {
        throw new Error(`save customer id failed: ${saveError.message}`);
      }
      result.customerId = customer.id;

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: PRICE_ID }],
        trial_period_days: 30,
        trial_settings: {
          end_behavior: { missing_payment_method: "cancel" },
        },
        metadata: {
          tradeflow_business_id: business.id,
          backfill: "preexisting-no-pm",
          no_payment_method: "true",
        },
      });
      result.subscriptionId = subscription.id;

      if (subscription.status !== "trialing") {
        throw new Error(
          `expected Stripe status trialing, got ${subscription.status}`,
        );
      }

      const hook = await postStripeEvent(
        subscriptionEvent("customer.subscription.created", subscription),
      );
      result.webhookHandled = hook.status === 200 && hook.json.handled === true;
      if (!result.webhookHandled) {
        throw new Error(
          `webhook did not sync: http=${hook.status} body=${JSON.stringify(hook.json)}`,
        );
      }

      const { data: synced } = await admin
        .from("businesses")
        .select(
          "stripe_customer_id, stripe_subscription_id, stripe_subscription_status, trial_ends_at",
        )
        .eq("id", business.id)
        .single();

      result.status = synced?.stripe_subscription_status ?? null;
      result.trialEndsAt = synced?.trial_ends_at ?? null;
      result.canAccept = canAcceptOrders(synced);
      if (!result.canAccept) {
        throw new Error(
          `webhook ran but canAcceptOrders is false (status=${result.status})`,
        );
      }

      console.log(
        `OK  ${business.name}  cus=${customer.id}  sub=${subscription.id}  status=${result.status}  trial_ends_at=${result.trialEndsAt}  NO_PAYMENT_METHOD`,
      );
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`FAIL  ${business.name}  ${result.error}`);
    }
    results.push(result);
  }

  const { data: census } = await admin
    .from("businesses")
    .select(
      "id, name, slug, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, trial_ends_at",
    )
    .is("deleted_at", null)
    .order("name", { ascending: true });

  console.log("\n=== CENSUS (all live businesses) ===");
  let blocked = 0;
  for (const row of census ?? []) {
    const accept = canAcceptOrders(row);
    if (!accept) blocked += 1;
    console.log(
      `${accept ? "ACCEPT" : "BLOCK "}  ${row.name}  status=${row.stripe_subscription_status ?? "null"}  cus=${row.stripe_customer_id ?? "null"}  sub=${row.stripe_subscription_id ?? "null"}`,
    );
  }

  const healed = [];
  for (const row of census ?? []) {
    if (canAcceptOrders(row)) continue;
    if (!row.stripe_customer_id) continue;
    try {
      if (row.stripe_subscription_id) {
        try {
          await stripe.subscriptions.cancel(row.stripe_subscription_id);
        } catch (cancelErr) {
          console.log(
            `       cancel ${row.stripe_subscription_id} skipped: ${cancelErr.message}`,
          );
        }
      }
      const subscription = await stripe.subscriptions.create({
        customer: row.stripe_customer_id,
        items: [{ price: PRICE_ID }],
        trial_period_days: 30,
        trial_settings: {
          end_behavior: { missing_payment_method: "cancel" },
        },
        metadata: {
          tradeflow_business_id: row.id,
          backfill: "heal-inactive-no-pm",
          no_payment_method: "true",
        },
      });
      const hook = await postStripeEvent(
        subscriptionEvent("customer.subscription.created", subscription),
      );
      const { data: synced } = await admin
        .from("businesses")
        .select("stripe_subscription_status, trial_ends_at")
        .eq("id", row.id)
        .single();
      const ok =
        hook.json.handled === true && canAcceptOrders(synced);
      healed.push({ name: row.name, ok, status: synced?.stripe_subscription_status });
      console.log(
        `${ok ? "HEAL" : "HEAL-FAIL"}  ${row.name}  ${row.stripe_subscription_status ?? "null"} → ${synced?.stripe_subscription_status}  NO_PAYMENT_METHOD`,
      );
    } catch (err) {
      healed.push({ name: row.name, ok: false, status: null });
      console.error(
        `HEAL-FAIL  ${row.name}  ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { data: finalCensus } = await admin
    .from("businesses")
    .select(
      "id, name, stripe_customer_id, stripe_subscription_status, trial_ends_at",
    )
    .is("deleted_at", null)
    .order("name", { ascending: true });

  let stillBlocked = 0;
  console.log("\n=== FINAL CENSUS ===");
  for (const row of finalCensus ?? []) {
    const accept = canAcceptOrders(row);
    if (!accept) stillBlocked += 1;
    console.log(
      `${accept ? "ACCEPT" : "BLOCK "}  ${row.name}  status=${row.stripe_subscription_status ?? "null"}  cus=${row.stripe_customer_id ?? "null"}`,
    );
  }

  const failed = results.filter((r) => r.error);
  const healFailed = healed.filter((h) => !h.ok);
  console.log("\n=== BACKFILL SUMMARY ===");
  console.log(`New customers + trials: ${results.length} (${results.filter((r) => r.canAccept).length} synced)`);
  console.log(`Healed inactive existing customers: ${healed.length}`);
  console.log(`Failed: ${failed.length + healFailed.length}`);
  console.log(`Live businesses that cannot accept new orders: ${stillBlocked}`);
  if (failed.length || healFailed.length || stillBlocked) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
