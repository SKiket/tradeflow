/**
 * Verifies paid-order fulfilment via Checkout webhooks on an isolated tagged shop
 * (never ek-pousserd). Covers card, pay-by-bank, failure, idempotency, sale
 * inventory movement, and concurrent last-unit races.
 *
 * Requires Next.js + TWILIO_DRY_RUN. Run:
 *   node scripts/verify-fulfil-order.mjs
 */
import { createHmac, randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import {
  assertNotPilotBusiness,
  createAdmin,
  deleteTestBusiness,
  hashTag,
  loadVerifyEnv,
  newRunId,
  phoneFromRunId,
  PILOT_SLUG,
} from "./lib/verify-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
process.env.TWILIO_DRY_RUN = process.env.TWILIO_DRY_RUN ?? "true";

const env = loadVerifyEnv();
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
const admin = createAdmin();
const stripe = new Stripe(env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-06-24.dahlia",
});
const runId = newRunId("fulfil");
const tag = hashTag(runId).slice(0, 10);
const createdOrderIds = [];

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

async function saleMovements(variantId, orderId) {
  const { data, error } = await admin
    .from("inventory_movements")
    .select("id, change, stock_after, reason, order_id")
    .eq("variant_id", variantId)
    .eq("reason", "sale")
    .eq("order_id", orderId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function createShop() {
  const email = `fulfil-${tag}@example.com`;
  const password = `Fulfil-${tag}!aA1`;
  const slug = `fulfil-${tag}`;
  if (slug === PILOT_SLUG || slug.startsWith("ek-pousser")) {
    throw new Error("refusing pilot slug");
  }

  const { data: pilot } = await admin
    .from("businesses")
    .select(
      "stripe_connected_account_id, stripe_charges_enabled, stripe_transfers_capability_active",
    )
    .eq("slug", PILOT_SLUG)
    .maybeSingle();
  if (!pilot?.stripe_connected_account_id || !pilot.stripe_charges_enabled) {
    throw new Error("pilot Connect account not ready (read-only borrow)");
  }

  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (uErr) throw uErr;
  const userId = created.user.id;

  const buyerPhone = phoneFromRunId(runId, 1);
  const sellerPhone = phoneFromRunId(runId, 2);

  const { data: business, error: bErr } = await admin
    .from("businesses")
    .insert({
      owner_user_id: userId,
      name: `Fulfil Shop ${tag}`,
      slug,
      stripe_subscription_status: "active",
      stripe_charges_enabled: true,
      stripe_transfers_capability_active: true,
      stripe_connected_account_id: pilot.stripe_connected_account_id,
      whatsapp_phone_e164: buyerPhone,
      seller_whatsapp_phone_e164: sellerPhone,
    })
    .select("id, slug, stripe_connected_account_id")
    .single();
  if (bErr) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw bErr;
  }
  await assertNotPilotBusiness(admin, business.id, "createShop");

  const { data: product, error: pErr } = await admin
    .from("products")
    .insert({
      business_id: business.id,
      name: `Fulfil Product ${tag}`,
      price_pence: 1500,
      active: true,
    })
    .select("id, price_pence")
    .single();
  if (pErr) throw pErr;

  const { data: variant, error: vErr } = await admin
    .from("product_variants")
    .insert({
      business_id: business.id,
      product_id: product.id,
      label: "Default",
      stock_quantity: 50,
      reserved_quantity: 0,
      track_inventory: true,
    })
    .select("id")
    .single();
  if (vErr) throw vErr;

  const { data: customer, error: cErr } = await admin
    .from("customers")
    .insert({
      business_id: business.id,
      phone_e164: buyerPhone,
      name: "Fulfil Buyer",
    })
    .select("id, phone_e164")
    .single();
  if (cErr) throw cErr;

  return {
    userId,
    business,
    product,
    variant,
    customer,
    unitPrice: product.price_pence,
    sellerPhone,
  };
}

async function createAwaitingPaymentOrder(
  businessId,
  customerId,
  threadId,
  variantId,
  unitPrice,
  qty = 1,
  { reserve = true } = {},
) {
  const orderRef =
    `TF${tag.slice(0, 6)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      .toUpperCase()
      .slice(0, 32);
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
  createdOrderIds.push(order.id);

  await admin.from("order_items").insert({
    order_id: order.id,
    business_id: businessId,
    product_variant_id: variantId,
    quantity: qty,
    unit_price_pence: unitPrice,
  });

  if (reserve) {
    const { data: cur } = await admin
      .from("product_variants")
      .select("reserved_quantity, track_inventory")
      .eq("id", variantId)
      .single();
    await admin
      .from("product_variants")
      .update({
        reserved_quantity: (cur?.reserved_quantity ?? 0) + qty,
        track_inventory: true,
      })
      .eq("id", variantId);
  }

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

async function countSellerMessages(businessId, pattern) {
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text")
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .ilike("normalised_text", pattern);
  return data ?? [];
}

async function main() {
  console.log(`runId=${runId} tag=${tag} BASE=${BASE}`);
  console.log("(isolated shop — never ek-pousserd)");

  let shop = null;
  try {
    shop = await createShop();
    const { business, customer, variant, unitPrice } = shop;
    const threadId = randomUUID();

    await admin
      .from("product_variants")
      .update({ stock_quantity: 50, reserved_quantity: 0, track_inventory: true })
      .eq("id", variant.id);

    // ========== Case 1: Card (sync paid) + sale movement ==========
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

    const liveSession = await stripe.checkout.sessions.retrieve(setup1.sessionId, {
      expand: ["payment_intent"],
    });
    let piId =
      typeof liveSession.payment_intent === "string"
        ? liveSession.payment_intent
        : liveSession.payment_intent?.id;
    if (!piId) {
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
    const sellerMsgs1 = await countSellerMessages(business.id, "%New paid order%");
    const sales1 = await saleMovements(variant.id, setup1.order.id);
    const sellerNotified =
      Boolean(cardResp.json.fulfil?.sellerMessageId) || sellerMsgs1.length >= 1;

    const case1Pass =
      cardResp.status === 200 &&
      cardResp.json.fulfil?.action === "fulfilled" &&
      order1?.status === "PAID" &&
      after1.stock_quantity === before1.stock_quantity - 1 &&
      after1.reserved_quantity === before1.reserved_quantity &&
      sales1.length === 1 &&
      sales1[0].change === -1 &&
      sales1[0].stock_after === after1.stock_quantity &&
      buyerMsgs1.length >= 1 &&
      sellerNotified;
    record(
      "Case 1: card paid → PAID, stock once, reservation released, one sale movement, WhatsApp",
      case1Pass,
      `events=${JSON.stringify(eventLog)}\norder=${order1?.status}\nstock ${before1.stock_quantity}→${after1.stock_quantity}, reserved ${before1.reserved_quantity}→${after1.reserved_quantity}\nsales=${JSON.stringify(sales1)}\ncardResp=${JSON.stringify(cardResp.json)}`,
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
    const sales2 = await saleMovements(variant.id, setup2.order.id);

    const case2Pass =
      pendingResp.json.fulfil?.action === "deferred" &&
      order2Pending?.status === "AWAITING_PAYMENT" &&
      mid2.reserved_quantity === before2.reserved_quantity + 1 &&
      asyncResp.json.fulfil?.action === "fulfilled" &&
      order2Final?.status === "PAID" &&
      after2.stock_quantity === before2.stock_quantity - 1 &&
      after2.reserved_quantity === before2.reserved_quantity &&
      sales2.length === 1 &&
      sales2[0].change === -1;
    record(
      "Case 2: Pay by Bank — completed (unpaid) then async_payment_succeeded + sale movement",
      case2Pass,
      `events=${JSON.stringify(eventLog)}\npending=${JSON.stringify(pendingResp.json)}\nasync=${JSON.stringify(asyncResp.json)}\nstatus: ${order2Pending?.status}→${order2Final?.status}\nsales=${JSON.stringify(sales2)}`,
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
    const sales4 = await saleMovements(variant.id, setup4.order.id);
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
      sales4.length === 1 &&
      sales4[0].change === -1 &&
      (confirmMsgs4.data ?? []).length === 1;
    record(
      "Case 4: duplicate webhook → no double decrement, one sale movement",
      case4Pass,
      `events=${JSON.stringify(eventLog)}\nfirst=${first.json.fulfil?.action}\nredeliver=${second.json.duplicate}\nretry=${third.json.fulfil?.action}\nstock ${before4.stock_quantity}→${after4.stock_quantity}\nsales=${JSON.stringify(sales4)}\nconfirmMsgs4=${(confirmMsgs4.data ?? []).length}`,
    );

    // ========== Case 5: concurrent last-unit ==========
    await admin
      .from("product_variants")
      .update({ stock_quantity: 1, reserved_quantity: 0, track_inventory: true })
      .eq("id", variant.id);

    const lastA = await createAwaitingPaymentOrder(
      business.id,
      customer.id,
      threadId,
      variant.id,
      unitPrice,
      1,
      { reserve: false },
    );
    const lastB = await createAwaitingPaymentOrder(
      business.id,
      customer.id,
      threadId,
      variant.id,
      unitPrice,
      1,
      { reserve: false },
    );

    const payloadA = checkoutEvent("checkout.session.completed", {
      id: lastA.sessionId,
      payment_status: "paid",
      metadata: { order_id: lastA.order.id, order_ref: lastA.order.order_ref },
    });
    const payloadB = checkoutEvent("checkout.session.completed", {
      id: lastB.sessionId,
      payment_status: "paid",
      metadata: { order_id: lastB.order.id, order_ref: lastB.order.order_ref },
    });
    const [respA, respB] = await Promise.all([
      postStripeEvent(payloadA),
      postStripeEvent(payloadB),
    ]);
    await sleep(1500);

    const lastStock = await getVariantState(variant.id);
    const { data: lastSales } = await admin
      .from("inventory_movements")
      .select("change, stock_after, order_id")
      .eq("variant_id", variant.id)
      .eq("reason", "sale")
      .in("order_id", [lastA.order.id, lastB.order.id]);
    const negative = (lastSales ?? []).some((m) => m.stock_after < 0);
    const actions = [respA.json.fulfil?.action, respB.json.fulfil?.action];

    const case5Pass =
      lastStock.stock_quantity === 0 &&
      !negative &&
      (lastSales ?? []).every((m) => m.change === -1) &&
      (lastSales ?? []).length >= 1 &&
      actions.includes("fulfilled");
    record(
      "Case 5: concurrent last-unit buys — stock ends 0, no negative sale stock_after",
      case5Pass,
      `actions=${JSON.stringify(actions)} stock=${lastStock.stock_quantity} sales=${JSON.stringify(lastSales)}`,
    );

    console.log("\n========================================");
    console.log("Event sequences observed:");
    console.log("  Card:     checkout.session.completed (payment_status=paid)");
    console.log("  PayBank:  checkout.session.completed (unpaid) → async_payment_succeeded");
    console.log("  Fail:     checkout.session.async_payment_failed");
    console.log("  Idempotent redelivery: fulfilled → already_fulfilled");
    console.log("  Concurrent last unit: dual webhook race");
    console.log("========================================");

    const allPassed = results.every((r) => r.passed);
    console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
    return allPassed ? 0 : 1;
  } finally {
    if (shop?.business?.id) {
      try {
        await assertNotPilotBusiness(admin, shop.business.id, "cleanup");
        await deleteTestBusiness(admin, shop.business.id, {
          ownerUserId: shop.userId,
        });
        console.log(`cleaned shop ${shop.business.slug}`);
      } catch (e) {
        console.warn("cleanup:", e.message);
        await deleteOrdersByIdsSafe(createdOrderIds);
      }
    }
  }
}

async function deleteOrdersByIdsSafe(ids) {
  const { deleteOrdersByIds } = await import("./lib/verify-harness.mjs");
  await deleteOrdersByIds(admin, ids);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exit(1);
  });
