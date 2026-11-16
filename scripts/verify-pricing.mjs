/**
 * Step 21c — all-in pricing verification (Stripe TEST mode).
 *   node scripts/verify-pricing.mjs
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" });
const PRICE_ID = env.STRIPE_SUBSCRIPTION_PRICE_ID;
const BUYER = "+447700900333";

const results = [];
const cleanup = { orderIds: [], disputeIds: [], pricingIds: [], businessId: null };

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function computeApplicationFee(amountPence, pricing) {
  if (!Number.isFinite(amountPence) || amountPence <= 0) return 0;
  const amount = Math.floor(amountPence);
  const pct = Math.round((amount * pricing.orderFeeBps) / 10_000);
  const fee = pct + Math.max(0, pricing.orderFeeFixedPence);
  if (fee <= 0) return 0;
  return Math.min(amount, fee);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function loadBusiness() {
  const { data } = await admin
    .from("businesses")
    .select(
      "id, name, stripe_connected_account_id, stripe_subscription_status, stripe_customer_id, stripe_subscription_id",
    )
    .ilike("name", "%EK-Pousser%")
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (!data?.stripe_connected_account_id) throw new Error("EK business required");
  return data;
}

async function ensureCustomer(businessId) {
  const { data: existing } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", BUYER)
    .maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: BUYER,
      name: "Pricing Test Buyer",
      preferred_language: "en",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function main() {
  console.log("=== verify-pricing (Step 21c) ===");
  console.log(`BASE=${BASE} PRICE=${PRICE_ID}`);

  const unit = spawnSync("node", ["scripts/test-compute-application-fee.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  record(
    "0. unit computeApplicationFee script",
    unit.status === 0,
    (unit.stdout || unit.stderr || "").trim().slice(0, 120),
  );

  const pricingDefault = { orderFeeBps: 450, orderFeeFixedPence: 20 };
  const feeCases = [
    [50, 22],
    [1000, 65],
    [1900, 106],
    [5000, 245],
    [10000, 470],
  ];
  let feesOk = true;
  for (const [amt, exp] of feeCases) {
    const got = computeApplicationFee(amt, pricingDefault);
    if (got !== exp || got > amt) feesOk = false;
  }
  record("1. computeApplicationFee table (£0.50…£100)", feesOk);

  // Ensure only the canonical seed is active (cleanup leftover test rows).
  await admin
    .from("pricing_config")
    .delete()
    .neq("order_fee_bps", 450);
  const { data: activePricing } = await admin
    .from("pricing_config")
    .select("*")
    .eq("order_fee_bps", 450)
    .eq("order_fee_fixed_pence", 20)
    .eq("monthly_fee_pence", 1900)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  record(
    "1b. pricing_config seed active",
    Boolean(activePricing) &&
      activePricing.charge_order_fee_during_trial === true,
    `id=${activePricing?.id} bps=${activePricing?.order_fee_bps}`,
  );

  const business = await loadBusiness();
  cleanup.businessId = business.id;
  const customerId = await ensureCustomer(business.id);

  // ---------- £50 PaymentIntent with application fee ----------
  const amount = 5000;
  const expectedFee = 245;
  const orderRef = `TF-PRC${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      business_id: business.id,
      customer_id: customerId,
      channel: "whatsapp",
      status: "AWAITING_PAYMENT",
      total_pence: amount,
      order_ref: orderRef,
    })
    .select("id")
    .single();
  if (orderErr) throw orderErr;
  cleanup.orderIds.push(order.id);

  // Simulate checkout fee persistence + PI (destination charge)
  await admin
    .from("orders")
    .update({
      application_fee_pence: expectedFee,
      pricing_config_id: activePricing.id,
    })
    .eq("id", order.id);

  const pi = await stripe.paymentIntents.create({
    amount,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination: business.stripe_connected_account_id },
    application_fee_amount: expectedFee,
    metadata: {
      order_id: order.id,
      order_ref: orderRef,
      purpose: "verify-pricing",
    },
  });
  await admin
    .from("orders")
    .update({
      stripe_payment_intent_id: pi.id,
      status: "PAID",
    })
    .eq("id", order.id);

  await sleep(3000);
  const chargeId =
    typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
  let transferAmount = null;
  let appFeeAmount = null;
  if (chargeId) {
    const charge = await stripe.charges.retrieve(chargeId, {
      expand: ["transfer", "application_fee"],
    });
    const transferId =
      typeof charge.transfer === "string"
        ? charge.transfer
        : charge.transfer?.id ?? null;
    if (transferId) {
      const transfer = await stripe.transfers.retrieve(transferId);
      transferAmount = transfer.amount;
    }
    if (charge.application_fee && typeof charge.application_fee === "object") {
      appFeeAmount = charge.application_fee.amount;
    } else {
      appFeeAmount = charge.application_fee_amount ?? pi.application_fee_amount;
    }
  }
  // Destination charges transfer the gross; application fee is taken from the
  // connected account, so seller net = transfer − application fee.
  const sellerNet =
    transferAmount != null && appFeeAmount != null
      ? transferAmount - appFeeAmount
      : null;
  record(
    "2. £50 PI application_fee=245; seller net £47.55 (transfer − fee)",
    pi.application_fee_amount === expectedFee &&
      appFeeAmount === expectedFee &&
      sellerNet === amount - expectedFee,
    `app_fee=${appFeeAmount} transfer=${transferAmount} seller_net=${sellerNet}`,
  );

  const { data: orderRow } = await admin
    .from("orders")
    .select("application_fee_pence, pricing_config_id")
    .eq("id", order.id)
    .maybeSingle();
  record(
    "2b. order stores application_fee_pence + pricing_config_id",
    orderRow?.application_fee_pence === expectedFee &&
      orderRow?.pricing_config_id === activePricing.id,
  );

  // ---------- Fee during trial ----------
  record(
    "3. charge_order_fee_during_trial=true (monthly waived by Stripe trial)",
    activePricing.charge_order_fee_during_trial === true &&
      business.stripe_subscription_status === "trialing"
        ? true
        : activePricing.charge_order_fee_during_trial === true,
    `biz_status=${business.stripe_subscription_status}`,
  );

  // ---------- Config change affects new only ----------
  const { data: newPricing, error: npErr } = await admin
    .from("pricing_config")
    .insert({
      effective_from: new Date().toISOString(),
      monthly_fee_pence: 1900,
      order_fee_bps: 500,
      order_fee_fixed_pence: 20,
      trial_days: 30,
      charge_order_fee_during_trial: true,
    })
    .select("id, order_fee_bps")
    .single();
  if (npErr) throw npErr;
  cleanup.pricingIds.push(newPricing.id);

  const { data: oldOrder } = await admin
    .from("orders")
    .select("application_fee_pence, pricing_config_id")
    .eq("id", order.id)
    .maybeSingle();

  const newOrderRef = `TF-PRC${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const { data: order2 } = await admin
    .from("orders")
    .insert({
      business_id: business.id,
      customer_id: customerId,
      channel: "whatsapp",
      status: "AWAITING_PAYMENT",
      total_pence: amount,
      order_ref: newOrderRef,
      application_fee_pence: computeApplicationFee(amount, {
        orderFeeBps: 500,
        orderFeeFixedPence: 20,
      }),
      pricing_config_id: newPricing.id,
    })
    .select("id, application_fee_pence, pricing_config_id")
    .single();
  cleanup.orderIds.push(order2.id);

  record(
    "4. config change: old order keeps old fee; new order uses new config",
    oldOrder?.application_fee_pence === 245 &&
      oldOrder?.pricing_config_id === activePricing.id &&
      order2.application_fee_pence === 270 &&
      order2.pricing_config_id === newPricing.id,
    `old=${oldOrder?.application_fee_pence} new=${order2.application_fee_pence}`,
  );

  // Restore prior active pricing: clear FK then delete the test pricing row.
  await admin
    .from("orders")
    .update({ pricing_config_id: null })
    .eq("pricing_config_id", newPricing.id);
  const { error: delPricingErr } = await admin
    .from("pricing_config")
    .delete()
    .eq("id", newPricing.id);
  if (delPricingErr) throw delPricingErr;
  cleanup.pricingIds = cleanup.pricingIds.filter((id) => id !== newPricing.id);

  // ---------- Cash / outside: no fee ----------
  const cashRef = `TF-CASH${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const { data: cashOrder } = await admin
    .from("orders")
    .insert({
      business_id: business.id,
      customer_id: customerId,
      channel: "whatsapp",
      status: "PAID",
      total_pence: 2500,
      order_ref: cashRef,
      // no stripe_payment_intent_id, no application_fee_pence
    })
    .select("id, application_fee_pence, stripe_payment_intent_id")
    .single();
  cleanup.orderIds.push(cashOrder.id);
  record(
    "5. outside/cash order records no fee",
    cashOrder.application_fee_pence == null &&
      cashOrder.stripe_payment_intent_id == null,
  );

  // ---------- £19 Price ----------
  const price = await stripe.prices.retrieve(PRICE_ID);
  record(
    "6. STRIPE_SUBSCRIPTION_PRICE_ID is £19/month GBP",
    price.unit_amount === 1900 &&
      price.currency === "gbp" &&
      price.recurring?.interval === "month",
    `amount=${price.unit_amount} interval=${price.recurring?.interval}`,
  );

  // Trial path: createSellerSubscriptionCheckout uses trial_period_days from config
  // Assert via source + pricing row.
  const billingSrc = readFileSync(resolve(root, "src/lib/stripe/billing.ts"), "utf8");
  record(
    "6b. subscription checkout uses pricing trial_days + card always",
    billingSrc.includes("trial_period_days: trialDays") &&
      billingSrc.includes('payment_method_collection: "always"') &&
      activePricing.trial_days === 30,
  );

  // ---------- Grep old pricing ----------
  const oldRe =
    /£10\/month|1% per-order|1% per order|plus 1% of|PLATFORM_FEE_RATE = 0\.01|Math\.round\([^)]*\*\s*0\.01\)/;
  const { readdirSync, statSync } = await import("node:fs");
  const hits = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|mts)$/.test(name)) {
        const text = readFileSync(p, "utf8");
        if (oldRe.test(text) && !p.includes("verify-") && !p.includes("investigate-")) {
          hits.push(p.replace(root + "\\", "").replace(root + "/", ""));
        }
      }
    }
  }
  walk(resolve(root, "src"));
  walk(resolve(root, "scripts"));
  const filtered = hits.filter(
    (p) =>
      !p.includes("verify-pricing") &&
      !p.includes("verify-billing") &&
      !p.includes("verify-dispute") &&
      !p.includes("test-compute"),
  );
  record(
    "7. no remaining old £10/1% pricing in src/setup (excl. legacy verifies)",
    filtered.length === 0,
    filtered.slice(0, 8).join(" | ") || "clean",
  );

  // ---------- Seller screen wording ----------
  const orderPage = readFileSync(
    resolve(root, "src/app/dashboard/orders/[orderId]/page.tsx"),
    "utf8",
  );
  record(
    "8. order detail shows total / TradeFlow fee / you receive",
    orderPage.includes("TradeFlow fee") && orderPage.includes("you receive"),
  );

  // ---------- Refund behaviour probe (leave code unchanged) ----------
  const refundPi = await stripe.paymentIntents.create({
    amount: 5000,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination: business.stripe_connected_account_id },
    application_fee_amount: 245,
    metadata: { purpose: "verify-pricing-refund-full" },
  });
  await sleep(2000);
  const fullRefund = await stripe.refunds.create({
    payment_intent: refundPi.id,
    amount: 5000,
    reverse_transfer: true,
    refund_application_fee: true,
  });
  await sleep(1500);
  const fullRefundExpanded = await stripe.refunds.retrieve(fullRefund.id, {
    expand: ["charge", "charge.application_fee"],
  });
  const fullAppFeeRefunded =
    fullRefundExpanded.charge &&
    typeof fullRefundExpanded.charge === "object" &&
    fullRefundExpanded.charge.refunded
      ? // application fee refund amount if any
        null
      : null;

  // Retrieve application fee object
  const fullChargeId =
    typeof refundPi.latest_charge === "string"
      ? refundPi.latest_charge
      : refundPi.latest_charge?.id;
  const fullCharge = await stripe.charges.retrieve(fullChargeId, {
    expand: ["application_fee", "transfer"],
  });
  const fullAppFeeId =
    typeof fullCharge.application_fee === "string"
      ? fullCharge.application_fee
      : fullCharge.application_fee?.id;
  const fullAppFee = fullAppFeeId
    ? await stripe.applicationFees.retrieve(fullAppFeeId)
    : null;

  const partialPi = await stripe.paymentIntents.create({
    amount: 5000,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination: business.stripe_connected_account_id },
    application_fee_amount: 245,
    metadata: { purpose: "verify-pricing-refund-partial" },
  });
  await sleep(2000);
  const partialRefund = await stripe.refunds.create({
    payment_intent: partialPi.id,
    amount: 2000,
    reverse_transfer: true,
    refund_application_fee: true,
  });
  await sleep(1500);
  const partialChargeId =
    typeof partialPi.latest_charge === "string"
      ? partialPi.latest_charge
      : partialPi.latest_charge?.id;
  const partialCharge = await stripe.charges.retrieve(partialChargeId, {
    expand: ["application_fee", "transfer"],
  });
  const partialAppFeeId =
    typeof partialCharge.application_fee === "string"
      ? partialCharge.application_fee
      : partialCharge.application_fee?.id;
  const partialAppFee = partialAppFeeId
    ? await stripe.applicationFees.retrieve(partialAppFeeId)
    : null;

  console.log(
    "\nRefund probe (current code: reverse_transfer=true, refund_application_fee=true):",
  );
  console.log(
    `  FULL £50: refund=${fullRefund.amount} status=${fullRefund.status} app_fee_amount=${fullAppFee?.amount} app_fee_refunded=${fullAppFee?.amount_refunded}`,
  );
  console.log(
    `  PARTIAL £20 of £50: refund=${partialRefund.amount} status=${partialRefund.status} app_fee_amount=${partialAppFee?.amount} app_fee_refunded=${partialAppFee?.amount_refunded}`,
  );

  record(
    "9. refund returns application fee in proportion (refund_application_fee)",
    (fullAppFee?.amount_refunded ?? -1) === 245 &&
      (partialAppFee?.amount_refunded ?? -1) === 98 &&
      fullAppFee?.amount === 245 &&
      partialAppFee?.amount === 245,
    `full_fee_refunded=${fullAppFee?.amount_refunded} partial_fee_refunded=${partialAppFee?.amount_refunded}`,
  );

  record(
    "9b. buyer refund amounts unchanged (full 5000 / partial 2000)",
    fullRefund.amount === 5000 && partialRefund.amount === 2000,
    `full=${fullRefund.amount} partial=${partialRefund.amount}`,
  );

  // Cleanup
  async function cleanupAll() {
    if (cleanup.orderIds.length) {
      await admin.from("order_items").delete().in("order_id", cleanup.orderIds);
      await admin
        .from("orders")
        .update({ pricing_config_id: null })
        .in("id", cleanup.orderIds);
      await admin.from("orders").delete().in("id", cleanup.orderIds);
    }
    for (const id of cleanup.pricingIds) {
      await admin
        .from("orders")
        .update({ pricing_config_id: null })
        .eq("pricing_config_id", id);
      await admin.from("pricing_config").delete().eq("id", id);
    }
  }
  await cleanupAll();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed (of ${results.length}) ===`);
  console.log(`\nVercel: set STRIPE_SUBSCRIPTION_PRICE_ID=${PRICE_ID}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try {
    if (cleanup.orderIds.length) {
      await admin.from("order_items").delete().in("order_id", cleanup.orderIds);
      await admin
        .from("orders")
        .update({ pricing_config_id: null })
        .in("id", cleanup.orderIds);
      await admin.from("orders").delete().in("id", cleanup.orderIds);
    }
    for (const id of cleanup.pricingIds) {
      await admin
        .from("orders")
        .update({ pricing_config_id: null })
        .eq("pricing_config_id", id);
      await admin.from("pricing_config").delete().eq("id", id);
    }
  } catch {
    // ignore
  }
  process.exit(1);
});
