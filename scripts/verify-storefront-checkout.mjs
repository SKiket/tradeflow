/**
 * Verifies structured storefront checkout (web cart, no order_parse):
 *   1. Two-product cart → AWAITING_PAYMENT + reservation + Stripe Checkout URL
 *   2. Payment webhook → PAID, stock decremented, WhatsApp to form phone + tracking link
 *   3. Out-of-stock item → clean 409, no order created
 *   4. Dispatch + tracking page + seller dashboard (thread_id null)
 *   5. Existing "Order via WhatsApp" links still present
 *
 * Run (dev server):
 *   node scripts/verify-storefront-checkout.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const WEBHOOK = `${BASE}/api/webhooks/ingress`;
const BUYER = "+447733308706";
const EK_EMAIL = "sgkiket@gmail.com";
const BAKER_ST = {
  line1: "221B Baker Street",
  line2: "Flat 2",
  city: "London",
  postcode: "NW1 6XE",
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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
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

function checkoutEvent(type, session) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    data: { object: { object: "checkout.session", ...session } },
  });
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

async function mintEkCookies() {
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
    email: EK_EMAIL,
  });
  if (linkError) throw linkError;
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError) throw otpError;
  return cookies;
}

async function signIn(email) {
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${BASE}/auth/callback` },
  });
  if (linkError) throw linkError;
  const client = createClient(url, anon, {
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

async function fetchHtml(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
    cache: "no-store",
  });
  const body = await response.text();
  return { status: response.status, body };
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function extractWaMeHrefs(html) {
  const raw = [...html.matchAll(/https:\/\/wa\.me\/[^"'\\\s]+/g)].map((m) =>
    decodeHtmlEntities(m[0]),
  );
  return [...new Set(raw)];
}

async function main() {
  const { data: business, error } = await admin
    .from("businesses")
    .select("id, slug, name, owner_user_id, stripe_charges_enabled")
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!business) throw new Error("EK-Pousser_D not found");
  if (!business.stripe_charges_enabled) {
    throw new Error("Seller Stripe cannot accept charges");
  }

  const { data: catalog } = await admin
    .from("products")
    .select(
      "id, name, price_pence, active, product_variants(id, label, stock_quantity, reserved_quantity, track_inventory, deleted_at)",
    )
    .eq("business_id", business.id)
    .eq("active", true)
    .is("deleted_at", null)
    .order("name", { ascending: true });

  const products = (catalog ?? [])
    .map((p) => ({
      ...p,
      variant: (p.product_variants ?? []).find((v) => !v.deleted_at),
    }))
    .filter((p) => p.variant);

  const mug = products.find((p) => /blue mug/i.test(p.name));
  const tote = products.find((p) => /tote/i.test(p.name));
  const soap = products.find((p) => /soap/i.test(p.name));
  if (!mug?.variant || !tote?.variant || !soap?.variant) {
    throw new Error("Need mug, tote, and soap variants in the catalog");
  }

  console.log(`BASE ${BASE}`);
  console.log(`Business ${business.name} slug=${business.slug} id=${business.id}`);
  console.log(`Mug ${mug.variant.id} @ ${mug.price_pence}p`);
  console.log(`Tote ${tote.variant.id} @ ${tote.price_pence}p\n`);

  // Ensure stock for the two cart items
  for (const item of [mug, tote]) {
    await admin
      .from("product_variants")
      .update({
        stock_quantity: Math.max(item.variant.stock_quantity ?? 0, 10),
        track_inventory: true,
      })
      .eq("id", item.variant.id);
  }

  const { data: mugBefore } = await admin
    .from("product_variants")
    .select("stock_quantity, reserved_quantity")
    .eq("id", mug.variant.id)
    .single();
  const { data: toteBefore } = await admin
    .from("product_variants")
    .select("stock_quantity, reserved_quantity")
    .eq("id", tote.variant.id)
    .single();

  const catalogPage = await fetchHtml(`/s/${business.slug}`);
  const waLinks = extractWaMeHrefs(catalogPage.body);
  const hasAddToCart = /Add to cart/i.test(catalogPage.body);
  const hasCheckoutCopy = /Checkout/i.test(catalogPage.body) || /Add to cart/i.test(catalogPage.body);
  const mugWa = waLinks.find((href) =>
    decodeURIComponent(href).toLowerCase().includes("classic blue mug"),
  );
  record(
    "5. Storefront still shows Order via WhatsApp links (and Add to cart)",
    catalogPage.status === 200 && Boolean(mugWa) && hasAddToCart,
    `status=${catalogPage.status} waLinks=${waLinks.length} mugWa=${Boolean(mugWa)} addToCart=${hasAddToCart} checkoutHint=${hasCheckoutCopy}`,
  );

  const checkoutPage = await fetchHtml(`/s/${business.slug}/checkout`);
  record(
    "Checkout page states WhatsApp is the update channel",
    checkoutPage.status === 200 &&
      /send order updates to this WhatsApp number/i.test(checkoutPage.body),
    `status=${checkoutPage.status}`,
  );

  const place = await fetch(`${BASE}/api/storefront/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessId: business.id,
      customerName: "Web Checkout Buyer",
      customerPhone: BUYER,
      items: [
        { variantId: mug.variant.id, quantity: 1 },
        { variantId: tote.variant.id, quantity: 1 },
      ],
    }),
  });
  const placed = await place.json().catch(() => ({}));

  const { data: order } = placed.orderId
    ? await admin
        .from("orders")
        .select(
          "id, order_ref, status, total_pence, thread_id, channel, reserved_until, stripe_checkout_session_id, customer_id",
        )
        .eq("id", placed.orderId)
        .maybeSingle()
    : { data: null };

  const { data: items } = order
    ? await admin
        .from("order_items")
        .select("product_variant_id, quantity, unit_price_pence")
        .eq("order_id", order.id)
    : { data: [] };

  const { data: mugHeld } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", mug.variant.id)
    .single();
  const { data: toteHeld } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", tote.variant.id)
    .single();

  const expectedTotal = mug.price_pence + tote.price_pence;
  const itemIds = new Set((items ?? []).map((row) => row.product_variant_id));
  const case1 =
    place.status === 200 &&
    placed.ok === true &&
    typeof placed.checkoutUrl === "string" &&
    /^https:\/\/checkout\.stripe\.com\//.test(placed.checkoutUrl) &&
    order?.status === "AWAITING_PAYMENT" &&
    order.thread_id === null &&
    order.channel === "storefront" &&
    order.total_pence === expectedTotal &&
    Boolean(order.reserved_until) &&
    Boolean(order.stripe_checkout_session_id) &&
    itemIds.has(mug.variant.id) &&
    itemIds.has(tote.variant.id) &&
    (items ?? []).length === 2 &&
    mugHeld.reserved_quantity === (mugBefore.reserved_quantity ?? 0) + 1 &&
    toteHeld.reserved_quantity === (toteBefore.reserved_quantity ?? 0) + 1;

  record(
    "1. Two-product web checkout → AWAITING_PAYMENT, reservation, real Stripe URL",
    case1,
    `status=${place.status} body=${JSON.stringify({ ok: placed.ok, orderRef: placed.orderRef, url: placed.checkoutUrl, error: placed.error })}\norder=${JSON.stringify(order)}\nitems=${JSON.stringify(items)}\nreserved mug ${mugBefore.reserved_quantity}→${mugHeld.reserved_quantity} tote ${toteBefore.reserved_quantity}→${toteHeld.reserved_quantity}`,
  );

  if (!order) {
    throw new Error("No order created — cannot continue payment/dispatch checks");
  }

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
  await sleep(2000);

  const { data: paidOrder } = await admin
    .from("orders")
    .select("status, thread_id, shipping_address")
    .eq("id", order.id)
    .single();
  const { data: mugAfterPay } = await admin
    .from("product_variants")
    .select("stock_quantity, reserved_quantity")
    .eq("id", mug.variant.id)
    .single();
  const { data: toteAfterPay } = await admin
    .from("product_variants")
    .select("stock_quantity, reserved_quantity")
    .eq("id", tote.variant.id)
    .single();
  const { data: buyerMsgs } = await admin
    .from("messages")
    .select("id, normalised_text, thread_id")
    .eq("customer_id", order.customer_id)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${order.order_ref}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  const confirmMsg = (buyerMsgs ?? []).find((m) =>
    /Payment received/i.test(m.normalised_text ?? ""),
  );
  const trackingInMsg =
    typeof confirmMsg?.normalised_text === "string" &&
    confirmMsg.normalised_text.includes(`/t/${order.order_ref}`);

  const case2 =
    paidResp.status === 200 &&
    paidResp.json.fulfil?.action === "fulfilled" &&
    paidOrder?.status === "PAID" &&
    paidOrder.thread_id === null &&
    mugAfterPay.stock_quantity === mugBefore.stock_quantity - 1 &&
    toteAfterPay.stock_quantity === toteBefore.stock_quantity - 1 &&
    mugAfterPay.reserved_quantity === mugBefore.reserved_quantity &&
    toteAfterPay.reserved_quantity === toteBefore.reserved_quantity &&
    Boolean(confirmMsg) &&
    trackingInMsg;

  record(
    "2. Payment fulfils like WhatsApp origin: PAID, stock, WhatsApp to form phone + tracking link",
    case2,
    `webhook=${paidResp.status} fulfil=${JSON.stringify(paidResp.json.fulfil)}\nstatus=${paidOrder?.status} thread=${paidOrder?.thread_id}\nstock mug ${mugBefore.stock_quantity}→${mugAfterPay.stock_quantity} tote ${toteBefore.stock_quantity}→${toteAfterPay.stock_quantity}\nmsg=${confirmMsg?.normalised_text ?? "(none)"}`,
  );

  const { data: soapBefore } = await admin
    .from("product_variants")
    .select("stock_quantity, reserved_quantity, track_inventory")
    .eq("id", soap.variant.id)
    .single();
  const { count: ordersBefore } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", business.id);

  try {
    await admin
      .from("product_variants")
      .update({
        stock_quantity: 0,
        reserved_quantity: 0,
        track_inventory: true,
      })
      .eq("id", soap.variant.id);

    const oos = await fetch(`${BASE}/api/storefront/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: business.id,
        customerName: "OOS Buyer",
        customerPhone: BUYER,
        items: [{ variantId: soap.variant.id, quantity: 1 }],
      }),
    });
    const oosJson = await oos.json().catch(() => ({}));
    const { count: ordersAfter } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id);

    const case3 =
      oos.status === 409 &&
      oosJson.code === "STOCK_UNAVAILABLE" &&
      !oosJson.orderId &&
      ordersAfter === ordersBefore;
    record(
      "3. Out-of-stock checkout rejected; no order created",
      case3,
      `status=${oos.status} body=${JSON.stringify(oosJson)} orders ${ordersBefore}→${ordersAfter}`,
    );
  } finally {
    await admin
      .from("product_variants")
      .update({
        stock_quantity: soapBefore.stock_quantity,
        reserved_quantity: soapBefore.reserved_quantity,
        track_inventory: soapBefore.track_inventory,
      })
      .eq("id", soap.variant.id);
  }

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) throw new Error("Owner email not found");
  const ownerToken = await signIn(ownerEmail);

  await admin.from("orders").update({ shipping_address: BAKER_ST }).eq("id", order.id);

  const quoted = await apiPost(ownerToken, `/api/orders/${order.id}/shipping-rates`, {});
  const rate = quoted.json.rates?.[0];
  let dispatch = { status: 0, json: {} };
  if (rate) {
    dispatch = await apiPost(ownerToken, `/api/orders/${order.id}/dispatch`, {
      rateObjectId: rate.objectId,
      shipmentId: quoted.json.shipmentId,
      carrier: rate.carrier,
    });
  }
  await sleep(1500);

  const { data: dispatched } = await admin
    .from("orders")
    .select("status, thread_id, dispatch_tracking_number, dispatch_carrier, channel")
    .eq("id", order.id)
    .single();

  const trackingPage = await fetchHtml(`/t/${order.order_ref}`);
  const cookies = await mintEkCookies();
  const dashList = await fetch(`${BASE}/dashboard/orders`, {
    headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    redirect: "manual",
    cache: "no-store",
  });
  const dashListHtml = await dashList.text();
  const dashDetail = await fetch(`${BASE}/dashboard/orders/${order.id}`, {
    headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    redirect: "manual",
    cache: "no-store",
  });
  const dashDetailHtml = await dashDetail.text();

  const { data: dispatchMsg } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("customer_id", order.customer_id)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${order.order_ref}%dispatched%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const case4 =
    dispatch.status === 200 &&
    dispatch.json.action === "dispatched" &&
    dispatched?.status === "DISPATCHED" &&
    dispatched.thread_id === null &&
    trackingPage.status === 200 &&
    trackingPage.body.includes(order.order_ref) &&
    /dispatched/i.test(trackingPage.body) &&
    dashList.status === 200 &&
    dashListHtml.includes(order.order_ref) &&
    dashDetail.status === 200 &&
    dashDetailHtml.includes(order.order_ref) &&
    Boolean(dispatched.dispatch_tracking_number);

  record(
    "4. Web order dispatches, tracks on /t, appears on seller dashboard; thread_id null",
    case4,
    `quoted=${quoted.status} dispatch=${dispatch.status} ${JSON.stringify(dispatch.json)}\norder=${JSON.stringify(dispatched)}\ntrack=${trackingPage.status} dashList=${dashList.status} dashDetail=${dashDetail.status}\nmsg=${dispatchMsg?.normalised_text ?? "(none)"}`,
  );

  console.log("\n========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
