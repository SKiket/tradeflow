/**
 * Verifies the 24h reservation / Checkout window (reconciling Step 10 vs 12).
 *
 *  1. Real confirm, no backdating — Stripe expires_at and reserved_until ~24h
 *  2. Organic window is long enough that a 12h chase reminder can fire
 *  3. Step 15 cancel still works while the 24h hold is live
 *  4. checkout.session.expired webhook vs payment_chase 24h cancel: either
 *     order, no double stock release
 *
 * Requires Next.js with CRON_SHARED_SECRET. Run:
 *   node scripts/verify-reservation-window.mjs
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const CRON_PATH = "/api/cron/payment-chase";
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447733308706";
const HOUR = 60 * 60;
const TWELVE_HOURS = 12 * HOUR;
const TWENTY_FOUR_HOURS = 24 * HOUR;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return env;
}

const env = loadEnv();
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
const CRON_SECRET = env.CRON_SHARED_SECRET;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY);

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(url, params) {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

function signStripe(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

let sidCounter = Date.now();
function nextSid() {
  sidCounter += 1;
  return `SM${sidCounter.toString(16)}${Math.random().toString(16).slice(2, 8)}`;
}

async function sendWhatsApp(bodyText) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${BUYER}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Reservation Window Tester",
    Body: bodyText,
    NumMedia: "0",
  };
  const body = new URLSearchParams(full).toString();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-Twilio-Signature": signTwilio(ENDPOINT, full),
    },
    body,
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function postCron() {
  const response = await fetch(new URL(CRON_PATH, BASE), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET },
    body: "{}",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function postExpiredWebhook(session) {
  const payload = JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type: "checkout.session.expired",
    data: {
      object: {
        object: "checkout.session",
        id: session.id,
        status: "expired",
        metadata: session.metadata ?? {},
      },
    },
  });
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function reservedOf(variantId) {
  const { data } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", variantId)
    .maybeSingle();
  return data?.reserved_quantity ?? 0;
}

async function cleanBuyerState(businessId) {
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", BUYER);
  const ids = (customers ?? []).map((c) => c.id);
  if (!ids.length) return;

  const { data: orders } = await admin
    .from("orders")
    .select("id, order_items(product_variant_id, quantity)")
    .eq("business_id", businessId)
    .in("customer_id", ids);

  for (const order of orders ?? []) {
    for (const item of order.order_items ?? []) {
      const { data: variant } = await admin
        .from("product_variants")
        .select("reserved_quantity, track_inventory")
        .eq("id", item.product_variant_id)
        .maybeSingle();
      if (variant?.track_inventory) {
        await admin
          .from("product_variants")
          .update({
            reserved_quantity: Math.max(0, (variant.reserved_quantity ?? 0) - item.quantity),
          })
          .eq("id", item.product_variant_id);
      }
    }
  }

  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length) {
    await admin.from("order_items").delete().in("order_id", orderIds);
    await admin.from("order_status_history").delete().in("order_id", orderIds);
    await admin.from("orders").delete().in("id", orderIds);
  }
}

async function createSyntheticOrder(ctx, { hoursAgo }) {
  const product = Array.isArray(ctx.variant.products)
    ? ctx.variant.products[0]
    : ctx.variant.products;
  const unitPrice = product?.price_pence ?? 100;
  const ref = `TF-WIN-${randomBytes(3).toString("hex").toUpperCase()}`;
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: ctx.business.id,
      customer_id: ctx.customer.id,
      thread_id: ctx.threadId,
      channel: "whatsapp",
      status: "AWAITING_PAYMENT",
      total_pence: unitPrice,
      order_ref: ref,
      reserved_until: new Date(Date.now() + (TWENTY_FOUR_HOURS - 60) * 1000).toISOString(),
    })
    .select("id, order_ref")
    .single();
  if (error) throw new Error(error.message);

  await admin.from("order_items").insert({
    order_id: order.id,
    business_id: ctx.business.id,
    product_variant_id: ctx.variant.id,
    quantity: 1,
    unit_price_pence: unitPrice,
  });
  const { data: currentVariant } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", ctx.variant.id)
    .single();
  await admin
    .from("product_variants")
    .update({ reserved_quantity: (currentVariant?.reserved_quantity ?? 0) + 1 })
    .eq("id", ctx.variant.id);
  ctx.variant.reserved_quantity = (currentVariant?.reserved_quantity ?? 0) + 1;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "gbp",
          unit_amount: unitPrice,
          product_data: { name: product?.name ?? "Window test" },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      transfer_data: { destination: ctx.business.stripe_connected_account_id },
      metadata: { order_id: order.id, order_ref: ref },
    },
    metadata: { order_id: order.id, order_ref: ref },
    success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE}/pay/cancelled?order_ref=${encodeURIComponent(ref)}`,
    expires_at: Math.floor(Date.now() / 1000) + TWENTY_FOUR_HOURS - 60,
  });
  await admin
    .from("orders")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", order.id);
  await admin.from("order_status_history").insert({
    order_id: order.id,
    business_id: ctx.business.id,
    from_status: "PENDING_CONFIRMATION",
    to_status: "AWAITING_PAYMENT",
    changed_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
  });
  return { ...order, sessionId: session.id };
}

async function main() {
  if (!CRON_SECRET) throw new Error("CRON_SHARED_SECRET missing");

  const { data: business } = await admin
    .from("businesses")
    .select("id, name, stripe_connected_account_id, stripe_charges_enabled")
    .eq("whatsapp_phone_e164", SANDBOX_NUMBER)
    .is("deleted_at", null)
    .maybeSingle();
  if (!business?.stripe_connected_account_id) {
    throw new Error("Sandbox business / Stripe not ready");
  }

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", BUYER)
    .is("deleted_at", null)
    .maybeSingle();
  if (!customer) throw new Error("Buyer customer not found");

  let { data: products } = await admin
    .from("products")
    .select(
      "id, name, price_pence, product_variants(id, label, stock_quantity, reserved_quantity, track_inventory, deleted_at)",
    )
    .eq("business_id", business.id)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("description", "%[order_parse_seed]%");
  const blueMug = (products ?? []).find((p) => /blue mug/i.test(p.name));
  const mugVariant = (blueMug?.product_variants ?? []).find((v) => !v.deleted_at);
  if (!mugVariant) throw new Error("Blue mug variant not found");

  const { data: latestMsg } = await admin
    .from("messages")
    .select("thread_id")
    .eq("business_id", business.id)
    .eq("customer_id", customer.id)
    .not("thread_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  await cleanBuyerState(business.id);
  await admin
    .from("product_variants")
    .update({ stock_quantity: 25, reserved_quantity: 0, track_inventory: true })
    .eq("id", mugVariant.id);

  // ----- 1 + 2: real confirm, no backdating -----
  await sendWhatsApp("I'd like 2 of the blue mug");
  await sleep(4000);
  const yesSend = await sendWhatsApp("yes");
  await sleep(5000);

  const orderId = yesSend.json.reply?.orderId;
  const sessionId = yesSend.json.reply?.checkoutSessionId;
  const { data: liveOrder } = await admin
    .from("orders")
    .select("id, status, reserved_until, stripe_checkout_session_id")
    .eq("id", orderId ?? "none")
    .maybeSingle();
  const session = sessionId ? await stripe.checkout.sessions.retrieve(sessionId) : null;
  const nowUnix = Math.floor(Date.now() / 1000);
  const expiresIn = session?.expires_at ? session.expires_at - nowUnix : 0;
  const reservedRemaining = liveOrder?.reserved_until
    ? (new Date(liveOrder.reserved_until).getTime() - Date.now()) / 1000
    : 0;
  const { data: payMsg } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("direction", "outbound")
    .ilike("normalised_text", "%secure payment link%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  record(
    "1. Real confirm: Stripe expires_at is ~24h (API), not 30 minutes",
    yesSend.json.reply?.replyAction === "confirmed" &&
      liveOrder?.status === "AWAITING_PAYMENT" &&
      session?.status === "open" &&
      expiresIn > TWELVE_HOURS &&
      expiresIn <= TWENTY_FOUR_HOURS &&
      /valid for 24 hours/i.test(payMsg?.normalised_text ?? ""),
    `stripe.expires_at=${session?.expires_at} (${(expiresIn / HOUR).toFixed(2)}h remaining) status=${session?.status} copy=${payMsg?.normalised_text ?? ""}`,
  );

  record(
    "2. Organic window: reserved_until survives long enough for a 12h reminder to fire",
    reservedRemaining > TWELVE_HOURS &&
      reservedRemaining <= TWENTY_FOUR_HOURS &&
      Math.abs(reservedRemaining - expiresIn) < 120,
    `reserved_until=${liveOrder?.reserved_until} (${(reservedRemaining / HOUR).toFixed(2)}h remaining); delta vs Stripe=${Math.abs(reservedRemaining - expiresIn).toFixed(0)}s`,
  );

  // ----- 3: Step 15 cancel while the 24h hold is still live -----
  const reservedBeforeCancel = await reservedOf(mugVariant.id);
  const cancelSend = await sendWhatsApp("actually cancel that");
  await sleep(4000);
  const { data: cancelled } = await admin
    .from("orders")
    .select("status, reserved_until")
    .eq("id", orderId)
    .maybeSingle();
  const reservedAfterCancel = await reservedOf(mugVariant.id);
  const sessionAfter = sessionId
    ? await stripe.checkout.sessions.retrieve(sessionId)
    : null;

  record(
    "3. Step 15 cancel still works inside the 24h window (2h-after-link scenario)",
    cancelSend.json.reply?.replyAction === "cancelled" &&
      cancelled?.status === "CANCELLED" &&
      cancelled?.reserved_until == null &&
      reservedAfterCancel === reservedBeforeCancel - 2 &&
      sessionAfter?.status === "expired" &&
      reservedRemaining > 2 * HOUR,
    `reply=${cancelSend.json.reply?.replyAction} status=${cancelled?.status} reserved ${reservedBeforeCancel}→${reservedAfterCancel} stripe=${sessionAfter?.status} holdWas=${(reservedRemaining / HOUR).toFixed(2)}h`,
  );

  // ----- 4: webhook-first then chase; chase-first then webhook -----
  const { data: variantNow } = await admin
    .from("product_variants")
    .select("id, reserved_quantity, track_inventory, products(price_pence, name)")
    .eq("id", mugVariant.id)
    .single();
  const ctx = {
    business,
    customer,
    variant: variantNow,
    threadId: latestMsg?.thread_id ?? crypto.randomUUID(),
  };

  const webhookFirst = await createSyntheticOrder(ctx, { hoursAgo: 24.25 });
  const reservedBeforeWebhook = await reservedOf(mugVariant.id);
  await stripe.checkout.sessions.expire(webhookFirst.sessionId);
  const expiredHook = await postExpiredWebhook({
    id: webhookFirst.sessionId,
    metadata: { order_id: webhookFirst.id, order_ref: webhookFirst.order_ref },
  });
  const { data: afterWebhook } = await admin
    .from("orders")
    .select("status, reserved_until")
    .eq("id", webhookFirst.id)
    .single();
  const reservedAfterWebhook = await reservedOf(mugVariant.id);
  const chaseAfterWebhook = await postCron();
  const cancelHitA = (chaseAfterWebhook.json.cancelled ?? []).find(
    (row) => row.orderId === webhookFirst.id,
  );
  const { data: afterChaseA } = await admin
    .from("orders")
    .select("status")
    .eq("id", webhookFirst.id)
    .single();
  const reservedAfterChaseA = await reservedOf(mugVariant.id);

  const chaseFirst = await createSyntheticOrder(ctx, { hoursAgo: 24.25 });
  const reservedBeforeChase = await reservedOf(mugVariant.id);
  const chaseRun = await postCron();
  const cancelHitB = (chaseRun.json.cancelled ?? []).find(
    (row) => row.orderId === chaseFirst.id,
  );
  const { data: afterChaseB } = await admin
    .from("orders")
    .select("status")
    .eq("id", chaseFirst.id)
    .single();
  const reservedAfterChaseB = await reservedOf(mugVariant.id);
  await postExpiredWebhook({
    id: chaseFirst.sessionId,
    metadata: { order_id: chaseFirst.id, order_ref: chaseFirst.order_ref },
  });
  const { data: afterHookB } = await admin
    .from("orders")
    .select("status")
    .eq("id", chaseFirst.id)
    .single();
  const reservedAfterHookB = await reservedOf(mugVariant.id);

  record(
    "4. Webhook-first then chase: EXPIRED → CANCELLED, stock released once",
    expiredHook.status === 200 &&
      afterWebhook?.status === "EXPIRED" &&
      reservedAfterWebhook === reservedBeforeWebhook - 1 &&
      cancelHitA?.via === "cancelAwaitingPaymentOrder" &&
      afterChaseA?.status === "CANCELLED" &&
      reservedAfterChaseA === reservedAfterWebhook,
    `hook=${expiredHook.status} afterWebhook=${afterWebhook?.status} chase=${afterChaseA?.status} reserved ${reservedBeforeWebhook}→${reservedAfterWebhook}→${reservedAfterChaseA} via=${cancelHitA?.via}`,
  );

  record(
    "4b. Chase-first then webhook: CANCELLED stays CANCELLED, stock released once",
    cancelHitB?.via === "cancelAwaitingPaymentOrder" &&
      afterChaseB?.status === "CANCELLED" &&
      reservedAfterChaseB === reservedBeforeChase - 1 &&
      afterHookB?.status === "CANCELLED" &&
      reservedAfterHookB === reservedAfterChaseB,
    `chase=${afterChaseB?.status} afterHook=${afterHookB?.status} reserved ${reservedBeforeChase}→${reservedAfterChaseB}→${reservedAfterHookB}`,
  );

  const failed = results.filter((r) => !r.passed);
  console.log("\n" + (failed.length ? `${failed.length} FAILED` : "ALL PASSED"));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
