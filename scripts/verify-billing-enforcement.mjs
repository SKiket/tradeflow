/**
 * Proves B2 billing enforcement: new orders require trialing/active;
 * dashboard, fulfilment, and tracking stay open when billing lapses.
 *
 * Run after backfill-seller-trials.mjs (dev server on :3000):
 *   node scripts/verify-billing-enforcement.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const WEBHOOK = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER_PHONE = "+447733308706";
const EK_EMAIL = "sgkiket@gmail.com";
const SHOP_UNAVAILABLE_BUYER_MESSAGE =
  "This shop isn't currently taking new orders. If you already have an order with us, we'll still fulfil it. Please try again later.";
const SHOP_UNAVAILABLE_STOREFRONT_HEADLINE =
  "This shop isn't currently taking orders";
const BAKER_ST = {
  line1: "221B Baker Street",
  line2: "Flat 2",
  city: "London",
  postcode: "NW1 6XE",
  country: "GB",
};
const FULFILMENT_PATHS = [
  "src/lib/orders/dispatch-order.ts",
  "src/lib/orders/refund-order.ts",
  "src/lib/tracking/public-order.ts",
  "src/app/t/[orderRef]/page.tsx",
  "src/app/api/orders/[orderId]/dispatch/route.ts",
  "src/app/api/orders/[orderId]/deliver/route.ts",
  "src/app/api/orders/[orderId]/refund/route.ts",
];

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

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function isEnforcementTestShop(row) {
  return /^Billing Enf /i.test(row.name ?? "") || /^billing-enf-/i.test(row.slug ?? "");
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
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail: detail ?? "" });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function checkoutEvent(type, session) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    data: { object: { object: "checkout.session", ...session } },
  });
}

function refundUpdatedEvent(refund) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type: "refund.updated",
    data: { object: refund },
  });
}

function signTwilio(url, params) {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
}

let sidCounter = Date.now();
function nextSid() {
  sidCounter += 1;
  return `SM${sidCounter.toString(16)}${Math.random().toString(16).slice(2, 8)}`;
}

async function sendWhatsApp(toNumber, bodyText, fromNumber = BUYER_PHONE) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${fromNumber}`,
    To: `whatsapp:${toNumber}`,
    ProfileName: "Billing Gate Tester",
    Body: bodyText,
    NumMedia: "0",
  };
  const body = new URLSearchParams(full).toString();
  const response = await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-Twilio-Signature": signTwilio(WEBHOOK, full),
    },
    body,
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function mintCookies(email) {
  const cookies = [];
  const supabase = createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookies.map((c) => ({ name: c.name, value: c.value }));
        },
        setAll(toSet) {
          for (const c of toSet) {
            const i = cookies.findIndex((x) => x.name === c.name);
            if (i >= 0) cookies[i] = { name: c.name, value: c.value };
            else cookies.push({ name: c.name, value: c.value });
          }
        },
      },
    },
  );
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError) throw otpError;
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function signIn(email) {
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
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
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function fetchHtml(path, cookie) {
  const headers = { Accept: "text/html" };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${BASE}${path}`, {
    headers,
    redirect: "manual",
    cache: "no-store",
  });
  const body = await response.text();
  return { status: response.status, body };
}

async function createConnectedAccount(email) {
  const account = await stripe.accounts.create({
    type: "custom",
    country: "GB",
    email,
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      mcc: "5734",
      product_description: "TradeFlow billing enforcement verifier",
      url: "https://tradeflow-tau-blush.vercel.app",
    },
    individual: {
      first_name: "Billing",
      last_name: "Enforcer",
      email,
      phone: "+447000000000",
      dob: { day: 1, month: 1, year: 1990 },
      address: {
        line1: "address_full_match",
        city: "London",
        postal_code: "SW1A 2AA",
        country: "GB",
      },
    },
    external_account: {
      object: "bank_account",
      country: "GB",
      currency: "gbp",
      account_holder_name: "Billing Enforcer",
      account_holder_type: "individual",
      routing_number: "108800",
      account_number: "00012345",
    },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    metadata: { tradeflow: "billing-enforcement-verify" },
  });
  for (let i = 0; i < 6; i += 1) {
    const refreshed = await stripe.accounts.retrieve(account.id);
    if (refreshed.charges_enabled) return refreshed;
    await sleep(1000);
  }
  return stripe.accounts.retrieve(account.id);
}

async function provisionSeller() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `billing-enf-${stamp}@tradeflow-test.local`;
  const slug = `billing-enf-${stamp}`.slice(0, 40);
  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password: "TestBilling!123",
    email_confirm: true,
  });
  if (userError) throw userError;
  const account = await createConnectedAccount(email);
  let connectedAccountId = account.id;
  let chargesEnabled = Boolean(account.charges_enabled);
  if (!chargesEnabled) {
    const { data: ekConnect } = await admin
      .from("businesses")
      .select("stripe_connected_account_id, stripe_charges_enabled")
      .eq("name", "EK-Pousser_D")
      .is("deleted_at", null)
      .maybeSingle();
    if (!ekConnect?.stripe_connected_account_id || !ekConnect.stripe_charges_enabled) {
      throw new Error(
        `Connected account ${account.id} charges_enabled=false and EK fallback missing`,
      );
    }
    connectedAccountId = ekConnect.stripe_connected_account_id;
    chargesEnabled = true;
    console.log(
      `       Connect fallback: ${account.id} pending_verification → using ${connectedAccountId}`,
    );
  }
  const { data: business, error: bizError } = await admin
    .from("businesses")
    .insert({
      owner_user_id: created.user.id,
      name: `Billing Enf ${stamp}`,
      slug,
      dispatch_address_line1: "10 Downing Street",
      dispatch_city: "London",
      dispatch_postcode: "SW1A 2AA",
      stripe_connected_account_id: connectedAccountId,
      stripe_charges_enabled: chargesEnabled,
      stripe_payouts_enabled: Boolean(account.payouts_enabled),
      stripe_details_submitted: true,
      whatsapp_phone_e164: `+4477${String(Date.now()).slice(-8)}`,
    })
    .select("id, slug, name, whatsapp_phone_e164")
    .single();
  if (bizError) throw new Error(bizError.message);

  const { data: product, error: productError } = await admin
    .from("products")
    .insert({
      business_id: business.id,
      name: "Enforcement Widget",
      description: "Used only by scripts/verify-billing-enforcement.mjs",
      price_pence: 1800,
      active: true,
    })
    .select("id")
    .single();
  if (productError) throw new Error(productError.message);

  const { data: variant, error: variantError } = await admin
    .from("product_variants")
    .insert({
      product_id: product.id,
      business_id: business.id,
      label: "Standard",
      stock_quantity: 20,
      track_inventory: true,
    })
    .select("id")
    .single();
  if (variantError) throw new Error(variantError.message);

  return {
    email,
    userId: created.user.id,
    business,
    variantId: variant.id,
    accountId: connectedAccountId,
  };
}

async function startNoCardTrial(businessId, email, name) {
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { tradeflow_business_id: businessId, purpose: "enforcement-verify" },
  });
  const { error: saveError } = await admin
    .from("businesses")
    .update({ stripe_customer_id: customer.id })
    .eq("id", businessId);
  if (saveError) throw new Error(saveError.message);

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: PRICE_ID }],
    trial_period_days: 30,
    trial_settings: {
      end_behavior: { missing_payment_method: "cancel" },
    },
    metadata: { tradeflow_business_id: businessId },
  });
  const hook = await postStripeEvent(
    subscriptionEvent("customer.subscription.created", subscription),
  );
  if (hook.status !== 200 || hook.json.handled !== true) {
    throw new Error(`trial webhook failed: ${JSON.stringify(hook.json)}`);
  }
  return { customerId: customer.id, subscription };
}

async function placeStorefrontOrder(businessId, variantId, phone = BUYER_PHONE) {
  const response = await fetch(`${BASE}/api/storefront/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessId,
      customerName: "Enforcement Buyer",
      customerPhone: phone,
      items: [{ variantId, quantity: 1 }],
    }),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function payOrder(order, destination) {
  const pi = await stripe.paymentIntents.create({
    amount: order.total_pence,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination },
    metadata: { order_id: order.id, order_ref: order.order_ref },
  });
  await admin
    .from("orders")
    .update({ stripe_payment_intent_id: pi.id })
    .eq("id", order.id);

  const payload = checkoutEvent("checkout.session.completed", {
    id: order.stripe_checkout_session_id,
    payment_status: "paid",
    metadata: { order_id: order.id, order_ref: order.order_ref },
    collected_information: {
      shipping_details: {
        address: {
          line1: BAKER_ST.line1,
          line2: BAKER_ST.line2,
          city: BAKER_ST.city,
          postal_code: BAKER_ST.postcode,
          country: BAKER_ST.country,
        },
      },
    },
  });
  const paidResp = await postStripeEvent(payload);
  await sleep(1500);
  const { data: paid } = await admin
    .from("orders")
    .select(
      "id, order_ref, status, total_pence, customer_id, stripe_payment_intent_id, stripe_checkout_session_id",
    )
    .eq("id", order.id)
    .single();
  return { paidResp, paid, paymentIntentId: pi.id };
}

async function main() {
  if (!PRICE_ID) throw new Error("STRIPE_SUBSCRIPTION_PRICE_ID missing");
  if (!WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET missing");
  if (!TWILIO_TOKEN) throw new Error("TWILIO_AUTH_TOKEN missing");

  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`Dev server not reachable at ${BASE}`);

  console.log(`BASE ${BASE}`);
  console.log(`PRICE ${PRICE_ID}\n`);

  // --- 5 (code): fulfilment routes must not call canAcceptOrders ---
  const fulfilmentHits = [];
  for (const rel of FULFILMENT_PATHS) {
    const text = readFileSync(resolve(root, rel), "utf8");
    if (/canAcceptOrders/.test(text) || /billing-gate/.test(text)) {
      fulfilmentHits.push(rel);
    }
  }
  record(
    "0. Dispatch / deliver / refund / tracking do not call canAcceptOrders",
    fulfilmentHits.length === 0,
    fulfilmentHits.length ? fulfilmentHits.join(", ") : "no hits in fulfilment paths",
  );

  // --- 1. Backfill census: EK and every live business can accept orders ---
  const { data: census } = await admin
    .from("businesses")
    .select(
      "id, name, slug, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, trial_ends_at",
    )
    .is("deleted_at", null)
    .order("name", { ascending: true });

  const existing = (census ?? []).filter((row) => !isEnforcementTestShop(row));
  const ek = existing.find((row) => row.name === "EK-Pousser_D");
  const blocked = existing.filter((row) => !canAcceptOrders(row));
  const missingCustomer = existing.filter((row) => !row.stripe_customer_id);
  const ekOk =
    Boolean(ek) &&
    typeof ek.stripe_customer_id === "string" &&
    ek.stripe_customer_id.startsWith("cus_") &&
    ek.stripe_subscription_status === "trialing" &&
    canAcceptOrders(ek);
  record(
    "1a. EK-Pousser_D has a real trialing Stripe subscription; canAcceptOrders is true",
    ekOk,
    `cus=${ek?.stripe_customer_id ?? "null"} sub=${ek?.stripe_subscription_id ?? "null"} status=${ek?.stripe_subscription_status ?? "null"} trial_ends_at=${ek?.trial_ends_at ?? "null"}`,
  );
  record(
    "1b. No live business is missing a Stripe customer; none are walled off from new orders",
    missingCustomer.length === 0 && blocked.length === 0,
    missingCustomer.length || blocked.length
      ? `missingCustomer=${missingCustomer.map((r) => r.name).join(", ") || "none"} blocked=${blocked.map((r) => `${r.name}:${r.stripe_subscription_status}`).join(", ") || "none"}`
      : `live=${existing.length} all trialing/active`,
  );

  // --- Provision a dedicated shop, trial it, place+pay an order, then cancel ---
  const seller = await provisionSeller();
  const trial = await startNoCardTrial(
    seller.business.id,
    seller.email,
    seller.business.name,
  );
  const { data: trialRow } = await admin
    .from("businesses")
    .select("stripe_subscription_status, stripe_customer_id, trial_ends_at")
    .eq("id", seller.business.id)
    .single();
  record(
    "Setup. Test shop is trialing before any cancel",
    canAcceptOrders(trialRow) && trialRow.stripe_customer_id === trial.customerId,
    `status=${trialRow?.stripe_subscription_status} cus=${trialRow?.stripe_customer_id}`,
  );

  const placed = await placeStorefrontOrder(seller.business.id, seller.variantId);
  const { data: unpaid } = placed.json.orderId
    ? await admin
        .from("orders")
        .select(
          "id, order_ref, status, total_pence, customer_id, stripe_checkout_session_id",
        )
        .eq("id", placed.json.orderId)
        .maybeSingle()
    : { data: null };
  if (!unpaid) {
    throw new Error(
      `Could not create pre-cancel paid order: http=${placed.status} ${JSON.stringify(placed.json)}`,
    );
  }
  const { paid } = await payOrder(unpaid, seller.accountId);
  record(
    "Setup. Paid order exists on the test shop BEFORE cancellation",
    paid?.status === "PAID" && Boolean(paid.stripe_payment_intent_id),
    `order=${paid?.order_ref} status=${paid?.status} pi=${paid?.stripe_payment_intent_id}`,
  );

  const canceled = await stripe.subscriptions.cancel(trial.subscription.id);
  const cancelHook = await postStripeEvent(
    subscriptionEvent("customer.subscription.deleted", canceled),
  );
  const { data: canceledRow } = await admin
    .from("businesses")
    .select("stripe_subscription_status, trial_ends_at, stripe_customer_id")
    .eq("id", seller.business.id)
    .single();
  record(
    "2a. Stripe test-mode cancel synced to canceled via webhook (not a direct DB write)",
    canceled.status === "canceled" &&
      canceledRow?.stripe_subscription_status === "canceled" &&
      cancelHook.json.handled === true &&
      !canAcceptOrders(canceledRow),
    `stripe=${canceled.status} db=${canceledRow?.stripe_subscription_status} hook=${JSON.stringify(cancelHook.json)}`,
  );

  const closedStore = await fetchHtml(`/s/${seller.business.slug}`);
  const closedCheckout = await fetchHtml(`/s/${seller.business.slug}/checkout`);
  const storeHtml = decodeHtml(closedStore.body);
  const checkoutHtml = decodeHtml(closedCheckout.body);
  const storeClosed =
    closedStore.status === 200 &&
    storeHtml.includes(SHOP_UNAVAILABLE_STOREFRONT_HEADLINE) &&
    !storeHtml.includes("stripe_subscription_status") &&
    !storeHtml.includes("stripe_customer_id");
  record(
    "2b. Canceled shop storefront is 200 with honest closed state (not 404, not catalog)",
    storeClosed &&
      closedCheckout.status === 200 &&
      checkoutHtml.includes(SHOP_UNAVAILABLE_STOREFRONT_HEADLINE),
    `store=${closedStore.status} checkoutPage=${closedCheckout.status} headline=${storeHtml.includes(SHOP_UNAVAILABLE_STOREFRONT_HEADLINE)}`,
  );

  const blockedCheckout = await placeStorefrontOrder(
    seller.business.id,
    seller.variantId,
    "+447700900099",
  );
  const { count: ordersAfterBlock } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", seller.business.id);
  record(
    "2c. Storefront checkout API rejects new orders with a clear billing message",
    blockedCheckout.status === 403 &&
      blockedCheckout.json.code === "BILLING_INACTIVE" &&
      /isn't currently taking orders/i.test(blockedCheckout.json.error ?? "") &&
      !blockedCheckout.json.orderId,
    `http=${blockedCheckout.status} body=${JSON.stringify(blockedCheckout.json)} orderCount=${ordersAfterBlock}`,
  );

  const { data: ekBiz } = await admin
    .from("businesses")
    .select("id, whatsapp_phone_e164")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  const ekPhone = ekBiz?.whatsapp_phone_e164 ?? null;
  const testPhone = seller.business.whatsapp_phone_e164;
  const { count: draftsBefore } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", seller.business.id)
    .eq("status", "PENDING_CONFIRMATION");

  let wa;
  try {
    if (ekBiz?.id) {
      await admin
        .from("businesses")
        .update({ whatsapp_phone_e164: null })
        .eq("id", ekBiz.id);
    }
    await admin
      .from("businesses")
      .update({ whatsapp_phone_e164: SANDBOX_NUMBER })
      .eq("id", seller.business.id);
    wa = await sendWhatsApp(SANDBOX_NUMBER, "I'd like 1 Enforcement Widget please");
    await sleep(800);
  } finally {
    await admin
      .from("businesses")
      .update({ whatsapp_phone_e164: testPhone })
      .eq("id", seller.business.id);
    if (ekBiz?.id) {
      await admin
        .from("businesses")
        .update({ whatsapp_phone_e164: ekPhone })
        .eq("id", ekBiz.id);
    }
  }

  const inboundId = wa?.json?.messageId;
  const { data: inbound } = inboundId
    ? await admin
        .from("messages")
        .select("id, ai_parse_result, normalised_text")
        .eq("id", inboundId)
        .maybeSingle()
    : { data: null };
  const { data: outbound } = inboundId
    ? await admin
        .from("messages")
        .select("id, normalised_text, raw_payload")
        .eq("business_id", seller.business.id)
        .eq("direction", "outbound")
        .eq("normalised_text", SHOP_UNAVAILABLE_BUYER_MESSAGE)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };
  const { count: draftsAfter } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", seller.business.id)
    .eq("status", "PENDING_CONFIRMATION");

  record(
    "2d. WhatsApp order attempt gets the fixed unavailable message; no order_parse; no draft",
    wa?.status === 200 &&
      wa.json.shopUnavailable === true &&
      wa.json.parseStored === false &&
      inbound?.ai_parse_result == null &&
      outbound?.normalised_text === SHOP_UNAVAILABLE_BUYER_MESSAGE &&
      draftsAfter === draftsBefore,
    `http=${wa?.status} body=${JSON.stringify(wa?.json)} parse=${JSON.stringify(inbound?.ai_parse_result)} drafts ${draftsBefore}→${draftsAfter} outbound=${Boolean(outbound)}`,
  );

  // --- 3. Same canceled shop: paid-before-cancel order still fulfils ---
  await admin.from("orders").update({ shipping_address: BAKER_ST }).eq("id", paid.id);
  const token = await signIn(seller.email);
  const quoted = await apiPost(token, `/api/orders/${paid.id}/shipping-rates`, {});
  const rate = quoted.json.rates?.[0];
  const dispatch = rate
    ? await apiPost(token, `/api/orders/${paid.id}/dispatch`, {
        rateObjectId: rate.objectId,
        shipmentId: quoted.json.shipmentId,
        carrier: rate.carrier,
      })
    : { status: quoted.status, json: quoted.json };
  await sleep(1000);
  const { data: afterDispatch } = await admin
    .from("orders")
    .select("status, dispatch_tracking_number, order_ref")
    .eq("id", paid.id)
    .single();
  const tracking = await fetchHtml(`/t/${paid.order_ref}`);
  const deliver = await apiPost(token, `/api/orders/${paid.id}/deliver`);
  await sleep(500);
  const { data: afterDeliver } = await admin
    .from("orders")
    .select("status")
    .eq("id", paid.id)
    .single();
  const refund = await apiPost(token, `/api/orders/${paid.id}/refund`, {});
  if (refund.json.stripeRefundId) {
    const stripeRefund = await stripe.refunds.retrieve(refund.json.stripeRefundId);
    await postStripeEvent(refundUpdatedEvent({ ...stripeRefund, status: "succeeded" }));
    await sleep(800);
  }
  const { data: afterRefund } = await admin
    .from("orders")
    .select("status, refunded_amount_pence")
    .eq("id", paid.id)
    .single();

  record(
    "3. Paid-before-cancel order can still be dispatched, tracked, delivered, and refunded",
    dispatch.status === 200 &&
      afterDispatch?.status === "DISPATCHED" &&
      tracking.status === 200 &&
      tracking.body.includes(paid.order_ref) &&
      deliver.status === 200 &&
      afterDeliver?.status === "DELIVERED" &&
      refund.status === 200 &&
      (afterRefund?.status === "REFUNDED" || afterRefund?.status === "REFUND_PENDING"),
    `quote=${quoted.status} dispatch=${dispatch.status}/${afterDispatch?.status} tracking=${tracking.status} deliver=${deliver.status}/${afterDeliver?.status} refund=${refund.status}/${afterRefund?.status} ${refund.json.error ?? ""}`,
  );

  // --- 4. Dashboard still open, banner is status-specific, Manage billing works ---
  const cookie = await mintCookies(seller.email);
  const dash = await fetchHtml("/dashboard/orders", cookie);
  const settings = await fetchHtml("/dashboard/settings", cookie);
  const portal = await apiPost(token, "/api/dashboard/billing-portal");
  const bannerOk =
    dash.status === 200 &&
    /Your shop is not accepting new orders/i.test(dash.body) &&
    /subscription is canceled/i.test(dash.body) &&
    /Manage billing/i.test(dash.body);
  record(
    "4. Dashboard stays accessible with the canceled-status banner; Manage billing opens Portal",
    bannerOk &&
      settings.status === 200 &&
      portal.status === 200 &&
      typeof portal.json.url === "string" &&
      /billing\.stripe\.com/.test(portal.json.url) &&
      portal.json.customerId === trial.customerId,
    `dash=${dash.status} settings=${settings.status} portal=${portal.status} host=${portal.json.url ? new URL(portal.json.url).host : "none"} bannerCanceled=${/subscription is canceled/i.test(dash.body)}`,
  );

  // --- 5. Genuinely trialing EK is unaffected ---
  const ekStore = ek ? await fetchHtml(`/s/${ek.slug}`) : { status: 0, body: "" };
  const ekCatalog =
    ekStore.status === 200 &&
    /Add to cart/i.test(ekStore.body) &&
    !ekStore.body.includes(SHOP_UNAVAILABLE_STOREFRONT_HEADLINE);
  const { data: ekVariant } = ek
    ? await admin
        .from("product_variants")
        .select("id, stock_quantity")
        .eq("business_id", ek.id)
        .is("deleted_at", null)
        .gt("stock_quantity", 0)
        .limit(1)
        .maybeSingle()
    : { data: null };
  let ekCheckout = { status: 0, json: {} };
  if (ek && ekVariant) {
    ekCheckout = await placeStorefrontOrder(ek.id, ekVariant.id, "+447700900088");
  }
  const ekDash = await fetchHtml("/dashboard/orders", await mintCookies(EK_EMAIL));
  record(
    "5. Trialing EK-Pousser_D still shows catalog, accepts checkout, and has no paused banner",
    ekOk &&
      ekCatalog &&
      ekCheckout.status === 200 &&
      ekCheckout.json.ok === true &&
      ekDash.status === 200 &&
      !/Your shop is not accepting new orders/i.test(ekDash.body),
    `store=${ekStore.status} catalog=${ekCatalog} checkout=${ekCheckout.status} dash=${ekDash.status} orderRef=${ekCheckout.json.orderRef ?? "none"}`,
  );

  console.log("\n=== SUMMARY ===");
  for (const row of results) {
    console.log(`${row.passed ? "PASS" : "FAIL"}  ${row.name}`);
  }
  const failed = results.filter((r) => r.failed === true || r.passed === false);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
