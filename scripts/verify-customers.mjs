/**
 * Verifies /dashboard/customers using live order aggregates (not the unused
 * customers.order_count / lifetime_value_pence / last_order_at columns).
 *
 * Requires the Next.js dev server.
 *
 *   node scripts/verify-customers.mjs
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
const EK_EMAIL = "sgkiket@gmail.com";
const NEW_PHONE = `+44770${String(Date.now()).slice(-7)}`;
const REPEAT_PHONE = "+447700901012";
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

function checkoutEvent(session) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        object: "checkout.session",
        ...session,
      },
    },
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

async function fetchAuthed(path, cookies) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Cookie: cookieHeader(cookies), Accept: "text/html" },
    redirect: "manual",
    cache: "no-store",
  });
  const html = await response.text();
  return { status: response.status, location: response.headers.get("location"), html };
}

async function signIn(email) {
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const client = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "email",
  });
  if (error) throw error;
  return data.session.access_token;
}

async function placeAndPay(params) {
  const place = await fetch(`${BASE}/api/storefront/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessId: params.businessId,
      customerName: params.name,
      customerPhone: params.phone,
      items: [{ variantId: params.variantId, quantity: 1 }],
    }),
  });
  const placed = await place.json().catch(() => ({}));
  if (place.status !== 200 || !placed.orderId) {
    throw new Error(`checkout failed: ${place.status} ${JSON.stringify(placed)}`);
  }
  const { data: order } = await admin
    .from("orders")
    .select("id, order_ref, status, total_pence, stripe_checkout_session_id, customer_id")
    .eq("id", placed.orderId)
    .single();
  const payload = checkoutEvent({
    id: order.stripe_checkout_session_id,
    payment_status: "paid",
    metadata: { order_id: order.id, order_ref: order.order_ref },
    collected_information: {
      shipping_details: { address: { ...BAKER_ST, postal_code: BAKER_ST.postcode } },
    },
  });
  const paid = await postStripeEvent(payload);
  await sleep(1500);
  const { data: paidOrder } = await admin
    .from("orders")
    .select("id, status, total_pence, customer_id")
    .eq("id", order.id)
    .single();
  return { placed, paid, paidOrder };
}

const LIFETIME_STATUSES = [
  "PAID",
  "DISPATCHED",
  "DELIVERED",
  "REFUND_PENDING",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
];

function formatGbp(pence) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}

function isNewSegment(stats, now = Date.now()) {
  if (stats.order_count !== 1 || !stats.last_order_at) return false;
  return now - new Date(stats.last_order_at).getTime() <= 30 * 24 * 60 * 60 * 1000;
}

function isRepeatSegment(stats) {
  return stats.order_count > 1;
}

async function liveStats(customerId) {
  const { data } = await admin
    .from("orders")
    .select("status, total_pence, refunded_amount_pence, created_at")
    .eq("customer_id", customerId);
  let order_count = 0;
  let lifetime_value_pence = 0;
  let last_order_at = null;
  for (const order of data ?? []) {
    if (!LIFETIME_STATUSES.includes(order.status)) continue;
    order_count += 1;
    lifetime_value_pence += Math.max(
      0,
      (order.total_pence ?? 0) - (order.refunded_amount_pence ?? 0),
    );
    if (!last_order_at || order.created_at > last_order_at) {
      last_order_at = order.created_at;
    }
  }
  return { order_count, lifetime_value_pence, last_order_at };
}

async function customerByPhone(businessId, phone) {
  const { data } = await admin
    .from("customers")
    .select(
      "id, name, phone_e164, order_count, lifetime_value_pence, last_order_at, notes, tags",
    )
    .eq("business_id", businessId)
    .eq("phone_e164", phone)
    .maybeSingle();
  return data;
}

async function cleanupOtherUser(email) {
  const { data } = await admin.auth.admin.listUsers();
  const user = (data?.users ?? []).find((row) => row.email === email);
  if (!user) return;
  await admin.from("businesses").delete().eq("owner_user_id", user.id);
  await admin.auth.admin.deleteUser(user.id);
}

async function main() {
  const { data: business, error } = await admin
    .from("businesses")
    .select("id, slug, name")
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !business) throw new Error("EK-Pousser_D not found");

  const { data: allCustomers } = await admin
    .from("customers")
    .select("id, name, phone_e164, order_count, lifetime_value_pence, last_order_at")
    .eq("business_id", business.id);
  const { data: allOrders } = await admin
    .from("orders")
    .select("id, status")
    .eq("business_id", business.id);
  const paidOrderCount = (allOrders ?? []).filter((row) =>
    LIFETIME_STATUSES.includes(row.status),
  ).length;
  let historical = null;
  for (const customer of allCustomers ?? []) {
    const stats = await liveStats(customer.id);
    if (stats.order_count > 0 && (customer.order_count ?? 0) === 0) {
      historical = { customer, stats };
      break;
    }
  }
  if (!historical) {
    for (const customer of allCustomers ?? []) {
      const stats = await liveStats(customer.id);
      if (stats.order_count > 0) {
        historical = { customer, stats };
        break;
      }
    }
  }

  const cookies = await mintCookies(EK_EMAIL);
  if (historical) {
    const histPage = await fetchAuthed(
      `/dashboard/customers/${historical.customer.id}`,
      cookies,
    );
    const histList = await fetchAuthed("/dashboard/customers", cookies);
    const liveCount = String(historical.stats.order_count);
    const liveGbp = formatGbp(historical.stats.lifetime_value_pence);
    record(
      "1. Dashboard shows live order stats even when customer columns are stale/unused",
      histPage.status === 200 &&
        histPage.html.includes(liveCount) &&
        histPage.html.includes(liveGbp) &&
        histList.status === 200 &&
        paidOrderCount > 0,
      `customer=${historical.customer.name ?? historical.customer.phone_e164} columnCount=${historical.customer.order_count} live=${JSON.stringify(historical.stats)} detail=${histPage.status} paidOrders=${paidOrderCount}`,
    );
  } else {
    record(
      "1. Dashboard shows live order stats even when customer columns are stale/unused",
      false,
      `no customer with paid orders found; paidOrders=${paidOrderCount}`,
    );
  }

  const { data: mug } = await admin
    .from("products")
    .select("id, name, price_pence, product_variants(id, deleted_at, stock_quantity)")
    .eq("business_id", business.id)
    .eq("active", true)
    .ilike("name", "%blue mug%")
    .is("deleted_at", null)
    .maybeSingle();
  const variant = (mug?.product_variants ?? []).find((row) => !row.deleted_at);
  if (!mug || !variant) throw new Error("Classic Blue Mug variant missing");
  await admin
    .from("product_variants")
    .update({ stock_quantity: Math.max(variant.stock_quantity ?? 0, 20), track_inventory: true })
    .eq("id", variant.id);

  const newBefore = await liveStats(
    (await customerByPhone(business.id, NEW_PHONE))?.id ?? "missing",
  );
  const first = await placeAndPay({
    businessId: business.id,
    name: "Customer New Verify",
    phone: NEW_PHONE,
    variantId: variant.id,
  });
  const newAfterRow = await customerByPhone(business.id, NEW_PHONE);
  const newAfter = await liveStats(newAfterRow.id);
  const newGbp = formatGbp(newAfter.lifetime_value_pence);
  const newPage = await fetchAuthed(
    `/dashboard/customers/${newAfterRow.id}`,
    cookies,
  );
  const listAfterNew = await fetchAuthed("/dashboard/customers", cookies);
  const newOk =
    first.paidOrder?.status === "PAID" &&
    newAfter.order_count === newBefore.order_count + 1 &&
    newAfter.lifetime_value_pence ===
      newBefore.lifetime_value_pence + first.paidOrder.total_pence &&
    Boolean(newAfter.last_order_at) &&
    newPage.status === 200 &&
    newPage.html.includes(String(newAfter.order_count)) &&
    newPage.html.includes(newGbp) &&
    listAfterNew.html.includes("Customer New Verify") &&
    listAfterNew.html.includes(newGbp);
  record(
    "2. New paid order is counted live on /dashboard/customers immediately",
    newOk,
    `before=${JSON.stringify(newBefore)} after=${JSON.stringify(newAfter)} gbp=${newGbp} status=${first.paidOrder?.status} detail=${newPage.status}`,
  );

  const repeatBefore = await liveStats(
    (await customerByPhone(business.id, REPEAT_PHONE))?.id ?? "missing",
  );
  const r1 = await placeAndPay({
    businessId: business.id,
    name: "Customer Repeat Verify",
    phone: REPEAT_PHONE,
    variantId: variant.id,
  });
  const r2 = await placeAndPay({
    businessId: business.id,
    name: "Customer Repeat Verify",
    phone: REPEAT_PHONE,
    variantId: variant.id,
  });
  const repeatAfterRow = await customerByPhone(business.id, REPEAT_PHONE);
  const repeatAfter = await liveStats(repeatAfterRow.id);
  const expectedCount = repeatBefore.order_count + 2;
  const expectedLtv =
    repeatBefore.lifetime_value_pence +
    r1.paidOrder.total_pence +
    r2.paidOrder.total_pence;
  const repeatPage = await fetchAuthed(
    `/dashboard/customers/${repeatAfterRow.id}`,
    cookies,
  );
  const repeatOk =
    repeatAfter.order_count === expectedCount &&
    repeatAfter.lifetime_value_pence === expectedLtv &&
    isRepeatSegment(repeatAfter) &&
    isNewSegment(newAfter) &&
    repeatPage.html.includes(String(repeatAfter.order_count)) &&
    repeatPage.html.includes(formatGbp(repeatAfter.lifetime_value_pence));
  record(
    "3. Live stats categorise a genuine New vs Repeat customer",
    repeatOk,
    `new=${JSON.stringify(newAfter)} newSegment=${isNewSegment(newAfter)} repeat=${JSON.stringify(repeatAfter)} expectedCount=${expectedCount} expectedLtv=${expectedLtv}`,
  );

  const listPage = await fetchAuthed("/dashboard/customers", cookies);
  const listHasNew =
    listPage.status === 200 &&
    listPage.html.includes("Customer New Verify") &&
    listPage.html.includes("Customer Repeat Verify");
  record(
    "2b. Customers list shows both New and Repeat buyers after payment",
    listHasNew,
    `list=${listPage.status} listHasNames=${listHasNew}`,
  );

  const notes = `Verify note ${Date.now()}`;
  const { error: noteError } = await admin
    .from("customers")
    .update({ notes, tags: ["verify-tag", "london"] })
    .eq("id", newAfterRow.id);
  const afterEdit = await customerByPhone(business.id, NEW_PHONE);
  const editedPage = await fetchAuthed(`/dashboard/customers/${newAfterRow.id}`, cookies);
  record(
    "4. Notes and tags persist and render on the profile",
    !noteError &&
      afterEdit?.notes === notes &&
      (afterEdit?.tags ?? []).includes("verify-tag") &&
      editedPage.html.includes(notes) &&
      editedPage.html.includes("verify-tag"),
    `notes=${afterEdit?.notes} tags=${JSON.stringify(afterEdit?.tags)}`,
  );

  const orderPage = await fetchAuthed(`/dashboard/orders/${first.paidOrder.id}`, cookies);
  record(
    "5. Order detail links through to the customer profile",
    orderPage.status === 200 &&
      orderPage.html.includes(`/dashboard/customers/${newAfterRow.id}`) &&
      orderPage.html.includes("View customer profile"),
    `status=${orderPage.status}`,
  );

  const OTHER_EMAIL = `customers-other-${Date.now()}@tradeflow-test.local`;
  await cleanupOtherUser(OTHER_EMAIL);
  const { data: otherUser } = await admin.auth.admin.createUser({
    email: OTHER_EMAIL,
    email_confirm: true,
  });
  await admin.from("businesses").insert({
    owner_user_id: otherUser.user.id,
    name: "Customers Other Shop",
    slug: `customers-other-${Date.now()}`,
    dispatch_address_line1: "2 Other St",
    dispatch_city: "London",
    dispatch_postcode: "E2 2BB",
  });
  const otherCookies = await mintCookies(OTHER_EMAIL);
  const leakList = await fetchAuthed("/dashboard/customers", otherCookies);
  const leakDetail = await fetchAuthed(
    `/dashboard/customers/${newAfterRow.id}`,
    otherCookies,
  );
  const otherToken = await signIn(OTHER_EMAIL);
  const otherRls = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${otherToken}` } },
  });
  const { data: leakedRows } = await otherRls
    .from("customers")
    .select("id")
    .eq("id", newAfterRow.id);
  const { error: leakEdit } = await otherRls
    .from("customers")
    .update({ notes: "should not write" })
    .eq("id", newAfterRow.id);
  const afterLeak = await customerByPhone(business.id, NEW_PHONE);
  const noLeak =
    !(leakList.html ?? "").includes("Customer New Verify") &&
    (leakDetail.status === 404 ||
      /Customer not found/i.test(leakDetail.html) ||
      leakDetail.status === 307 ||
      leakDetail.status === 302) &&
    (leakedRows ?? []).length === 0 &&
    afterLeak?.notes === notes;
  record(
    "6. Other business cannot list, view, or edit EK customers",
    noLeak,
    `listStatus=${leakList.status} detailStatus=${leakDetail.status} rlsRows=${(leakedRows ?? []).length} editError=${leakEdit?.message ?? "none"} notesStill=${afterLeak?.notes === notes}`,
  );
  await cleanupOtherUser(OTHER_EMAIL);

  const allPassed = results.every((row) => row.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
