/**
 * Verifies POST /api/orders/[orderId]/refund + refund.updated webhook (Step 13).
 *
 * Cases:
 *  1. Full refund on DELIVERED order → REFUND_PENDING → REFUNDED via webhook
 *  2. Partial refund on PAID order → PARTIALLY_REFUNDED
 *  3. Refund exceeding remaining → rejected
 *  4. Refund CANCELLED pre-payment order → rejected
 *  5. Cross-tenant refund attempt → 404
 *
 * Requires Next.js dev server. Run:
 *   node scripts/verify-refunds.mjs
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
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" });

const results = [];
const eventLog = [];
let buyerRefundMessage = "";

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signStripe(payload, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex")}`;
}

function checkoutEvent(type, session) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    data: { object: { object: "checkout.session", ...session } },
  });
}

function refundUpdatedEvent(refund) {
  eventLog.push(`refund.updated:${refund.status}`);
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type: "refund.updated",
    data: { object: refund },
  });
}

async function postStripeEvent(payload) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signStripe(payload),
    },
    body: payload,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function postRefundWebhook(refund) {
  return postStripeEvent(refundUpdatedEvent(refund));
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function signIn(email) {
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${BASE}/auth/callback` },
  });
  if (linkError) throw linkError;
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sessionData, error: verifyError } = await client.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "email",
  });
  if (verifyError) throw verifyError;
  return sessionData.session.access_token;
}

async function apiPost(token, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function getVariantStock(variantId) {
  const { data } = await admin
    .from("product_variants")
    .select("stock_quantity")
    .eq("id", variantId)
    .single();
  return data?.stock_quantity;
}

async function cleanupOtherUser(email) {
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users?.find((u) => u.email === email);
  if (!user) return;
  await admin.from("businesses").delete().eq("owner_user_id", user.id);
  await admin.auth.admin.deleteUser(user.id);
}

/** Create AWAITING_PAYMENT order + Checkout Session, confirm card payment, fulfil via webhook. */
async function createPaidOrder(business, customer, variant, unitPrice, threadId) {
  const orderRef = `TF-REF-${Date.now().toString(16).toUpperCase()}`;
  const total = unitPrice;

  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      business_id: business.id,
      customer_id: customer.id,
      channel: "whatsapp",
      status: "AWAITING_PAYMENT",
      total_pence: total,
      order_ref: orderRef,
      thread_id: threadId,
      reserved_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .select("id, order_ref, total_pence, customer_id")
    .single();
  if (orderErr || !order) throw new Error(orderErr?.message ?? "order create failed");

  await admin.from("order_items").insert({
    order_id: order.id,
    business_id: business.id,
    product_variant_id: variant.id,
    quantity: 1,
    unit_price_pence: unitPrice,
  });

  await admin
    .from("product_variants")
    .update({ reserved_quantity: 1 })
    .eq("id", variant.id);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "gbp",
          unit_amount: unitPrice,
          product_data: { name: "Refund test item" },
        },
        quantity: 1,
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

  // Checkout Sessions no longer expose payment_intent until customer interaction —
  // create and confirm a matching destination charge PI for real refund testing.
  const pi = await stripe.paymentIntents.create({
    amount: total,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination: business.stripe_connected_account_id },
    metadata: { order_id: order.id, order_ref: orderRef },
  });

  await admin
    .from("orders")
    .update({ stripe_payment_intent_id: pi.id })
    .eq("id", order.id);

  const fulfilPayload = checkoutEvent("checkout.session.completed", {
    id: session.id,
    payment_status: "paid",
    metadata: { order_id: order.id, order_ref: orderRef },
  });
  await postStripeEvent(fulfilPayload);
  await sleep(1500);

  const { data: paid } = await admin
    .from("orders")
    .select("id, order_ref, status, total_pence, customer_id, stripe_payment_intent_id")
    .eq("id", order.id)
    .single();

  if (paid?.status !== "PAID") {
    throw new Error(`Expected PAID after fulfil, got ${paid?.status}`);
  }

  return { order: paid, variantId: variant.id, sessionId: session.id };
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, owner_user_id, stripe_connected_account_id, stripe_charges_enabled")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business?.stripe_charges_enabled) {
    throw new Error("Business Stripe not charge-ready");
  }

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) throw new Error("Owner email not found");

  await admin
    .from("businesses")
    .update({ seller_whatsapp_phone_e164: BUYER })
    .eq("id", business.id);

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", BUYER)
    .maybeSingle();
  if (!customer) throw new Error("Buyer customer not found");

  const { data: products } = await admin
    .from("products")
    .select("id, price_pence, product_variants(id, deleted_at)")
    .eq("business_id", business.id)
    .ilike("description", "%[order_parse_seed]%")
    .limit(1);
  const variant = (products?.[0]?.product_variants ?? []).find((v) => !v.deleted_at);
  if (!variant) throw new Error("No catalog variant");

  const unitPrice = products[0].price_pence;
  await admin
    .from("product_variants")
    .update({ stock_quantity: 50, reserved_quantity: 0, track_inventory: true })
    .eq("id", variant.id);

  const TEST_SHIPPING = {
    line1: "221B Baker Street",
    line2: "Flat 2",
    city: "London",
    postcode: "NW1 6XE",
    country: "GB",
  };

  async function dispatchWithShippo(token, orderId) {
    await admin
      .from("orders")
      .update({ shipping_address: TEST_SHIPPING })
      .eq("id", orderId);
    const quoted = await apiPost(token, `/api/orders/${orderId}/shipping-rates`, {});
    if (quoted.status !== 200 || !quoted.json.rates?.[0]) {
      throw new Error(
        `shipping-rates failed: ${quoted.status} ${JSON.stringify(quoted.json)}`,
      );
    }
    const rate = quoted.json.rates[0];
    return apiPost(token, `/api/orders/${orderId}/dispatch`, {
      rateObjectId: rate.objectId,
      shipmentId: quoted.json.shipmentId,
      carrier: rate.carrier,
    });
  }

  const ownerToken = await signIn(ownerEmail);
  const threadId = crypto.randomUUID();

  // ========== Setup: real paid + delivered order for test 1 ==========
  eventLog.length = 0;
  const setup1 = await createPaidOrder(business, customer, variant, unitPrice, threadId);
  const stockBefore1 = await getVariantStock(setup1.variantId);

  const dispatched1 = await dispatchWithShippo(ownerToken, setup1.order.id);
  if (dispatched1.status !== 200) {
    throw new Error(`dispatch failed: ${JSON.stringify(dispatched1.json)}`);
  }
  await apiPost(ownerToken, `/api/orders/${setup1.order.id}/deliver`, {});

  const { data: deliveredOrder } = await admin
    .from("orders")
    .select("status, stripe_payment_intent_id")
    .eq("id", setup1.order.id)
    .single();

  if (deliveredOrder?.status !== "DELIVERED") {
    throw new Error(`Expected DELIVERED, got ${deliveredOrder?.status}`);
  }
  if (!deliveredOrder.stripe_payment_intent_id) {
    throw new Error("stripe_payment_intent_id not captured at fulfilment");
  }

  // ========== Case 1: full refund on DELIVERED ==========
  const refund1 = await apiPost(ownerToken, `/api/orders/${setup1.order.id}/refund`, {
    reason: "Customer return",
  });

  const { data: pending1 } = await admin
    .from("orders")
    .select("status")
    .eq("id", setup1.order.id)
    .single();

  const stripeRefund1 = await stripe.refunds.retrieve(refund1.json.stripeRefundId);
  eventLog.push(`stripe_api:initial_status=${stripeRefund1.status}`);

  if (stripeRefund1.status === "pending") {
    await postRefundWebhook({ ...stripeRefund1, status: "pending" });
  }

  const webhook1 = await postRefundWebhook({ ...stripeRefund1, status: "succeeded" });
  await sleep(1500);

  const { data: final1 } = await admin
    .from("orders")
    .select("status, refunded_amount_pence, total_pence")
    .eq("id", setup1.order.id)
    .single();
  const stockAfter1 = await getVariantStock(setup1.variantId);

  const { data: buyerMsg1 } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("customer_id", setup1.order.customer_id)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${setup1.order.order_ref}%refund%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  buyerRefundMessage = buyerMsg1?.normalised_text ?? "";

  const case1Pass =
    refund1.status === 200 &&
    refund1.json.action === "refund_pending" &&
    pending1?.status === "REFUND_PENDING" &&
    final1?.status === "REFUNDED" &&
    final1?.refunded_amount_pence === final1?.total_pence &&
    stockBefore1 === stockAfter1 &&
    webhook1.status === 200;
  record(
    "Case 1: full refund DELIVERED → REFUND_PENDING → REFUNDED, stock unchanged",
    case1Pass,
    `api=${JSON.stringify(refund1.json)}\npending=${pending1?.status} final=${JSON.stringify(final1)}\nstripeInitial=${stripeRefund1.status}\nevents=${JSON.stringify(eventLog)}\nmsg=${buyerRefundMessage}`,
  );

  // ========== Case 2: partial refund on PAID order ==========
  const setup2 = await createPaidOrder(
    business,
    customer,
    variant,
    unitPrice,
    crypto.randomUUID(),
  );
  const half = Math.floor(setup2.order.total_pence / 2);

  const refund2 = await apiPost(ownerToken, `/api/orders/${setup2.order.id}/refund`, {
    amountPence: half,
    reason: "Partial goodwill",
  });

  const stripeRefund2 = await stripe.refunds.retrieve(refund2.json.stripeRefundId);
  await postRefundWebhook({ ...stripeRefund2, status: "succeeded" });
  await sleep(1500);

  const { data: final2 } = await admin
    .from("orders")
    .select("status, refunded_amount_pence, total_pence")
    .eq("id", setup2.order.id)
    .single();

  const case2Pass =
    refund2.status === 200 &&
    final2?.status === "PARTIALLY_REFUNDED" &&
    final2?.refunded_amount_pence === half &&
    half < final2.total_pence;
  record(
    "Case 2: partial refund → PARTIALLY_REFUNDED with correct amount",
    case2Pass,
    `half=${half} final=${JSON.stringify(final2)}`,
  );

  // ========== Case 3: exceed remaining ==========
  const remaining = final2.total_pence - final2.refunded_amount_pence;
  const refund3 = await apiPost(ownerToken, `/api/orders/${setup2.order.id}/refund`, {
    amountPence: remaining + 100,
  });
  const case3Pass =
    refund3.status === 400 &&
    refund3.json.error?.includes("exceeds");
  record(
    "Case 3: refund exceeding remaining → rejected",
    case3Pass,
    `status=${refund3.status} body=${JSON.stringify(refund3.json)} remaining=${remaining}`,
  );

  // ========== Case 4: CANCELLED order ==========
  const { data: cancelled } = await admin
    .from("orders")
    .insert({
      business_id: business.id,
      customer_id: customer.id,
      channel: "whatsapp",
      status: "CANCELLED",
      total_pence: unitPrice,
      order_ref: `TF-CANCEL-${Date.now().toString(16).toUpperCase()}`,
    })
    .select("id")
    .single();
  const refund4 = await apiPost(ownerToken, `/api/orders/${cancelled.id}/refund`, {});
  const case4Pass = refund4.status === 400 && refund4.json.status === "CANCELLED";
  record(
    "Case 4: CANCELLED pre-payment order → rejected before Stripe",
    case4Pass,
    `status=${refund4.status} body=${JSON.stringify(refund4.json)}`,
  );

  // ========== Case 5: cross-tenant ==========
  const OTHER = `other-refund-${Date.now()}@tradeflow-test.local`;
  await cleanupOtherUser(OTHER);
  const { data: otherUser } = await admin.auth.admin.createUser({
    email: OTHER,
    email_confirm: true,
  });
  await admin.from("businesses").insert({
    owner_user_id: otherUser.user.id,
    name: "Other Refund Shop",
    slug: `oref-${Date.now()}`,
    dispatch_address_line1: "1 St",
    dispatch_city: "London",
    dispatch_postcode: "E1 1AA",
    payout_account_holder_name: "O",
    payout_sort_code: "11-22-33",
    payout_account_number: "12345678",
  });
  const otherToken = await signIn(OTHER);
  const refund5 = await apiPost(otherToken, `/api/orders/${setup2.order.id}/refund`, {});
  const case5Pass = refund5.status === 404;
  record(
    "Case 5: cross-tenant refund → 404",
    case5Pass,
    `status=${refund5.status} body=${JSON.stringify(refund5.json)}`,
  );
  await cleanupOtherUser(OTHER);

  console.log("\n========================================");
  console.log("Refund webhook event sequence (test 1):");
  console.log(JSON.stringify(eventLog, null, 2));
  console.log("\nBuyer refund notification:");
  console.log(buyerRefundMessage || "(none)");
  console.log("========================================");

  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
