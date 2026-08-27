/**
 * Verifies Step 11: paid-order fulfilment via Checkout webhooks.
 *
 * Cases:
 *  1. Card — checkout.session.completed (payment_status paid) → PAID + stock + WhatsApp
 *  2. Pay by Bank — completed (unpaid) then async_payment_succeeded → PAID
 *  3. Pay by Bank failure — async_payment_failed → PAYMENT_FAILED + release
 *  4. Idempotency — redeliver same success webhook twice → no double fulfil
 *
 * Requires Next.js dev server. Run:
 *   node scripts/verify-fulfil-order.mjs
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
const BUYER = "+447733308706";
const SELLER = process.env.SELLER_PHONE ?? "+447733308706";

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
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" });

const results = [];
const eventLog = [];

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signStripe(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function checkoutEvent(type, session) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    data: {
      object: {
        object: "checkout.session",
        ...session,
      },
    },
  });
}

async function postStripeEvent(payload) {
  const parsed = JSON.parse(payload);
  eventLog.push(parsed.type);
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

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function getVariantState(variantId) {
  const { data } = await admin
    .from("product_variants")
    .select("stock_quantity, reserved_quantity")
    .eq("id", variantId)
    .single();
  return data;
}

async function createAwaitingPaymentOrder(businessId, customerId, threadId, variantId, unitPrice, qty = 1) {
  const orderRef = `TF-TEST-${Date.now().toString(16).toUpperCase()}`;
  const total = unitPrice * qty;

  const { data: business } = await admin
    .from("businesses")
    .select("stripe_connected_account_id")
    .eq("id", businessId)
    .single();

  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customerId,
      channel: "whatsapp",
      status: "AWAITING_PAYMENT",
      total_pence: total,
      order_ref: orderRef,
      thread_id: threadId,
      reserved_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .select("id, order_ref")
    .single();
  if (orderErr || !order) throw new Error(orderErr?.message ?? "order create failed");

  await admin.from("order_items").insert({
    order_id: order.id,
    business_id: businessId,
    product_variant_id: variantId,
    quantity: qty,
    unit_price_pence: unitPrice,
  });

  await admin
    .from("product_variants")
    .update({ reserved_quantity: qty })
    .eq("id", variantId);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card", "pay_by_bank"],
    line_items: [
      {
        price_data: {
          currency: "gbp",
          unit_amount: unitPrice,
          product_data: { name: "Test item" },
        },
        quantity: qty,
      },
    ],
    payment_intent_data: {
      transfer_data: { destination: business.stripe_connected_account_id },
      metadata: { order_id: order.id, order_ref: orderRef },
    },
    metadata: { order_id: order.id, order_ref: orderRef },
    success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE}/pay/cancelled`,
  });

  await admin
    .from("orders")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", order.id);

  return { order, sessionId: session.id, sessionUrl: session.url };
}

async function countOutboundMessages(customerId, pattern) {
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text")
    .eq("customer_id", customerId)
    .eq("direction", "outbound")
    .ilike("normalised_text", pattern);
  return data ?? [];
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, stripe_connected_account_id, stripe_charges_enabled")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business?.stripe_charges_enabled) {
    throw new Error("Business Stripe not charge-ready");
  }

  await admin
    .from("businesses")
    .update({ seller_whatsapp_phone_e164: SELLER })
    .eq("id", business.id);

  const { data: customer } = await admin
    .from("customers")
    .select("id, phone_e164")
    .eq("business_id", business.id)
    .eq("phone_e164", BUYER)
    .maybeSingle();
  if (!customer) throw new Error("Buyer customer not found — run verify-confirm-payment first");

  const { data: products } = await admin
    .from("products")
    .select("id, price_pence, product_variants(id, deleted_at)")
    .eq("business_id", business.id)
    .ilike("description", "%[order_parse_seed]%")
    .limit(1);
  const variant = (products?.[0]?.product_variants ?? []).find((v) => !v.deleted_at);
  if (!variant) throw new Error("No catalog variant");

  const threadId = crypto.randomUUID();
  const unitPrice = products[0].price_pence;

  await admin
    .from("product_variants")
    .update({ stock_quantity: 50, reserved_quantity: 0, track_inventory: true })
    .eq("id", variant.id);

  // ========== Case 1: Card (sync paid) ==========
  eventLog.length = 0;
  const before1 = await getVariantState(variant.id);
  const setup1 = await createAwaitingPaymentOrder(
    business.id,
    customer.id,
    threadId,
    variant.id,
    unitPrice,
    1,
  );

  // Real card payment via PaymentIntent confirm (creates paid session state)
  const liveSession = await stripe.checkout.sessions.retrieve(setup1.sessionId, {
    expand: ["payment_intent"],
  });
  let piId =
    typeof liveSession.payment_intent === "string"
      ? liveSession.payment_intent
      : liveSession.payment_intent?.id;
  if (!piId) {
    // PI created on first customer interaction — confirm via test PM on session
    const refreshed = await stripe.checkout.sessions.retrieve(setup1.sessionId, {
      expand: ["payment_intent"],
    });
    piId =
      typeof refreshed.payment_intent === "string"
        ? refreshed.payment_intent
        : refreshed.payment_intent?.id;
  }

  if (piId) {
    await stripe.paymentIntents.confirm(piId, {
      payment_method: "pm_card_visa",
      return_url: `${BASE}/pay/success`,
    });
  }

  const cardPayload = checkoutEvent("checkout.session.completed", {
    id: setup1.sessionId,
    payment_status: "paid",
    metadata: { order_id: setup1.order.id, order_ref: setup1.order.order_ref },
  });
  const cardResp = await postStripeEvent(cardPayload);
  await sleep(1500);

  const { data: order1 } = await admin
    .from("orders")
    .select("status")
    .eq("id", setup1.order.id)
    .single();
  const after1 = await getVariantState(variant.id);
  const buyerMsgs1 = await countOutboundMessages(customer.id, "%Payment received%");
  const sellerMsgs1 = await countOutboundMessages(customer.id, "%New paid order%");

  const case1Pass =
    cardResp.status === 200 &&
    cardResp.json.fulfil?.action === "fulfilled" &&
    order1?.status === "PAID" &&
    after1.stock_quantity === before1.stock_quantity - 1 &&
    after1.reserved_quantity === 0 &&
    buyerMsgs1.length >= 1 &&
    sellerMsgs1.length >= 1;
  record(
    "Case 1: card checkout.session.completed (paid) → PAID, stock, buyer+seller WhatsApp",
    case1Pass,
    `events=${JSON.stringify(eventLog)}\norder=${order1?.status}\nstock ${before1.stock_quantity}→${after1.stock_quantity}, reserved→${after1.reserved_quantity}\ncardResp=${JSON.stringify(cardResp.json)}`,
  );

  // ========== Case 2: Pay by Bank (async) ==========
  eventLog.length = 0;
  const before2 = await getVariantState(variant.id);
  const setup2 = await createAwaitingPaymentOrder(
    business.id,
    customer.id,
    threadId,
    variant.id,
    unitPrice,
    1,
  );

  const completedPending = checkoutEvent("checkout.session.completed", {
    id: setup2.sessionId,
    payment_status: "unpaid",
    metadata: { order_id: setup2.order.id, order_ref: setup2.order.order_ref },
  });
  const pendingResp = await postStripeEvent(completedPending);
  await sleep(500);
  const { data: order2Pending } = await admin
    .from("orders")
    .select("status")
    .eq("id", setup2.order.id)
    .single();
  const mid2 = await getVariantState(variant.id);

  const asyncSuccess = checkoutEvent("checkout.session.async_payment_succeeded", {
    id: setup2.sessionId,
    payment_status: "paid",
    metadata: { order_id: setup2.order.id, order_ref: setup2.order.order_ref },
  });
  const asyncResp = await postStripeEvent(asyncSuccess);
  await sleep(1500);
  const { data: order2Final } = await admin
    .from("orders")
    .select("status")
    .eq("id", setup2.order.id)
    .single();
  const after2 = await getVariantState(variant.id);

  const case2Pass =
    pendingResp.json.fulfil?.action === "deferred" &&
    order2Pending?.status === "AWAITING_PAYMENT" &&
    mid2.reserved_quantity === 1 &&
    asyncResp.json.fulfil?.action === "fulfilled" &&
    order2Final?.status === "PAID" &&
    after2.stock_quantity === before2.stock_quantity - 1 &&
    after2.reserved_quantity === 0;
  record(
    "Case 2: Pay by Bank — completed (unpaid) then async_payment_succeeded",
    case2Pass,
    `events=${JSON.stringify(eventLog)}\npending=${JSON.stringify(pendingResp.json)}\nasync=${JSON.stringify(asyncResp.json)}\nstatus: ${order2Pending?.status}→${order2Final?.status}`,
  );

  // ========== Case 3: Pay by Bank failure ==========
  eventLog.length = 0;
  const setup3 = await createAwaitingPaymentOrder(
    business.id,
    customer.id,
    threadId,
    variant.id,
    unitPrice,
    1,
  );
  const before3Reserved = (await getVariantState(variant.id)).reserved_quantity;

  const asyncFail = checkoutEvent("checkout.session.async_payment_failed", {
    id: setup3.sessionId,
    payment_status: "unpaid",
    metadata: { order_id: setup3.order.id, order_ref: setup3.order.order_ref },
  });
  const failResp = await postStripeEvent(asyncFail);
  await sleep(1500);

  const { data: order3 } = await admin
    .from("orders")
    .select("status")
    .eq("id", setup3.order.id)
    .single();
  const after3 = await getVariantState(variant.id);
  const failMsgs = await countOutboundMessages(customer.id, "%didn't go through%");

  const case3Pass =
    failResp.status === 200 &&
    order3?.status === "PAYMENT_FAILED" &&
    after3.reserved_quantity === before3Reserved - 1 &&
    failMsgs.length >= 1;
  record(
    "Case 3: async_payment_failed → PAYMENT_FAILED, release, buyer notified",
    case3Pass,
    `events=${JSON.stringify(eventLog)}\norder=${order3?.status}\nreserved ${before3Reserved}→${after3.reserved_quantity}`,
  );

  // ========== Case 4: Idempotency ==========
  eventLog.length = 0;
  const setup4 = await createAwaitingPaymentOrder(
    business.id,
    customer.id,
    threadId,
    variant.id,
    unitPrice,
    1,
  );
  const before4 = await getVariantState(variant.id);

  const dupPayload = checkoutEvent("checkout.session.completed", {
    id: setup4.sessionId,
    payment_status: "paid",
    metadata: { order_id: setup4.order.id, order_ref: setup4.order.order_ref },
  });
  const first = await postStripeEvent(dupPayload);
  await sleep(1000);
  // Stripe redelivers the same event id — ingress dedupes; fulfil guard is
  // additionally tested below with a fresh event id.
  const second = await postStripeEvent(dupPayload);
  await sleep(500);
  const redeliverPayload = checkoutEvent("checkout.session.completed", {
    id: setup4.sessionId,
    payment_status: "paid",
    metadata: { order_id: setup4.order.id, order_ref: setup4.order.order_ref },
  });
  const third = await postStripeEvent(redeliverPayload);
  await sleep(1000);

  const after4 = await getVariantState(variant.id);
  const confirmMsgs4 = await admin
    .from("messages")
    .select("id")
    .eq("customer_id", customer.id)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${setup4.order.order_ref}%`)
    .ilike("normalised_text", "%Payment received%");

  const case4Pass =
    first.json.fulfil?.action === "fulfilled" &&
    second.json.duplicate === true &&
    third.json.fulfil?.action === "already_fulfilled" &&
    after4.stock_quantity === before4.stock_quantity - 1 &&
    (confirmMsgs4.data ?? []).length === 1;
  record(
    "Case 4: duplicate webhook → ingress dedupe + fulfil guard, no double decrement",
    case4Pass,
    `events=${JSON.stringify(eventLog)}\nfirst=${first.json.fulfil?.action}\nredeliver=${second.json.duplicate}\nretry=${third.json.fulfil?.action}\nstock ${before4.stock_quantity}→${after4.stock_quantity}\nconfirmMsgs4=${(confirmMsgs4.data ?? []).length}`,
  );

  console.log("\n========================================");
  console.log("Event sequences observed:");
  console.log("  Card:     checkout.session.completed (payment_status=paid)");
  console.log("  PayBank:  checkout.session.completed (unpaid) → async_payment_succeeded");
  console.log("  Fail:     checkout.session.async_payment_failed");
  console.log("  Idempotent redelivery: fulfilled → already_fulfilled");
  console.log("========================================");

  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
