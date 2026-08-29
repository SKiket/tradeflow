/**
 * Verifies Stripe Checkout shipping address collection:
 *  1. Live Checkout Session has shipping_address_collection GB, hosted page
 *     includes the shipping form
 *  2. Fulfilment webhook writes orders.shipping_address
 *  3. Dashboard order detail shows the address
 *
 * Then re-run Step 11 fulfilment (see verify-fulfil-order.mjs) separately
 * for regression. This script covers capture + UI.
 *
 * Requires Next.js. Run:
 *   node scripts/verify-shipping-address.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447733308706";
const EK_EMAIL = "sgkiket@gmail.com";
const TEST_ADDRESS = {
  line1: "221B Baker Street",
  line2: "Flat 2",
  city: "London",
  postal_code: "NW1 6XE",
  country: "GB",
};

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

const env = loadEnv();
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" });
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(urlStr, params) {
  const sorted = Object.keys(params).sort();
  let data = urlStr;
  for (const k of sorted) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

function signStripe(payload, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex")}`;
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
    ProfileName: "Shipping Address Tester",
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

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
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
    .select("id")
    .eq("business_id", businessId)
    .in("customer_id", ids);
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length) {
    await admin.from("order_items").delete().in("order_id", orderIds);
    await admin.from("order_status_history").delete().in("order_id", orderIds);
    await admin.from("orders").delete().in("id", orderIds);
  }
  await admin.from("messages").delete().in("customer_id", ids);
}

async function mintCookies(email) {
  const cookies = [];
  const supabase = createBrowserClient(url, anon, {
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
  });
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
  return cookies;
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, whatsapp_phone_e164, stripe_charges_enabled")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business?.stripe_charges_enabled) {
    throw new Error("EK-Pousser_D Stripe not charge-ready");
  }
  if (business.whatsapp_phone_e164 !== SANDBOX_NUMBER) {
    throw new Error("Sandbox number not mapped to EK-Pousser_D");
  }

  await cleanBuyerState(business.id);
  await sendWhatsApp("I'd like 1 of the blue mug");
  await sleep(4000);
  const yes = await sendWhatsApp("yes");
  await sleep(2000);

  const { data: awaiting } = await admin
    .from("orders")
    .select("id, order_ref, status, stripe_checkout_session_id, shipping_address")
    .eq("business_id", business.id)
    .eq("status", "AWAITING_PAYMENT")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!awaiting?.stripe_checkout_session_id) {
    throw new Error(
      `No AWAITING_PAYMENT checkout session (draft=${JSON.stringify(yes.json.draft)})`,
    );
  }

  const session = await stripe.checkout.sessions.retrieve(awaiting.stripe_checkout_session_id);
  const allowed = session.shipping_address_collection?.allowed_countries ?? [];
  const hosted = session.url
    ? await fetch(session.url, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 TradeFlowShippingVerify" },
      })
    : null;
  const hostedHtml = hosted ? await hosted.text() : "";
  const hostedShowsShipping =
    /shipping/i.test(hostedHtml) &&
    (/address/i.test(hostedHtml) || /postal/i.test(hostedHtml) || /GB/i.test(hostedHtml));

  record(
    "1. Checkout Session collects GB shipping; hosted page includes shipping UI",
    session.status === "open" &&
      allowed.includes("GB") &&
      typeof session.url === "string" &&
      hostedShowsShipping,
    `session=${session.id} status=${session.status} allowed=${JSON.stringify(allowed)} url=${session.url} hostedStatus=${hosted?.status} hostedShowsShipping=${hostedShowsShipping} htmlChars=${hostedHtml.length}`,
  );

  const shippingPayload = {
    address: TEST_ADDRESS,
    name: "Test Buyer",
  };
  const payload = JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        object: "checkout.session",
        id: session.id,
        payment_status: "paid",
        metadata: { order_id: awaiting.id, order_ref: awaiting.order_ref },
        shipping_details: shippingPayload,
        collected_information: { shipping_details: shippingPayload },
      },
    },
  });
  const webhook = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signStripe(payload),
    },
    body: payload,
  });
  const webhookJson = await webhook.json().catch(() => ({}));
  await sleep(1500);

  const { data: paid } = await admin
    .from("orders")
    .select("id, status, shipping_address")
    .eq("id", awaiting.id)
    .single();
  const stored = paid?.shipping_address ?? {};
  const addressOk =
    stored.line1 === TEST_ADDRESS.line1 &&
    stored.line2 === TEST_ADDRESS.line2 &&
    stored.city === TEST_ADDRESS.city &&
    stored.postcode === TEST_ADDRESS.postal_code &&
    stored.country === TEST_ADDRESS.country;

  record(
    "2. Submitted address lands on orders.shipping_address after fulfilment",
    webhook.status === 200 &&
      webhookJson.fulfil?.action === "fulfilled" &&
      paid?.status === "PAID" &&
      addressOk,
    `status=${paid?.status} fulfil=${webhookJson.fulfil?.action} shipping_address=${JSON.stringify(stored)}`,
  );

  const cookies = await mintCookies(EK_EMAIL);
  const page = await fetch(`${BASE}/dashboard/orders/${awaiting.id}`, {
    headers: { Cookie: cookieHeader(cookies), "Cache-Control": "no-cache" },
    cache: "no-store",
    redirect: "manual",
  });
  const html = await page.text();
  const dashboardShows =
    html.includes(TEST_ADDRESS.line1) &&
    html.includes(TEST_ADDRESS.city) &&
    html.includes(TEST_ADDRESS.postal_code) &&
    /Delivery address/i.test(html);

  record(
    "3. Dashboard order detail displays the captured address",
    page.status === 200 && dashboardShows,
    `status=${page.status} dashboardShows=${dashboardShows}`,
  );

  try {
    await stripe.checkout.sessions.expire(session.id);
  } catch {
    // already complete
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log("\n========================================");
  console.log(
    failed === 0
      ? "SHIPPING ADDRESS VERIFICATION: PASSED"
      : `SHIPPING ADDRESS VERIFICATION: ${failed} FAILED`,
  );
  console.log("========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
