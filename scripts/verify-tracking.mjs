/**
 * Verifies the public /t/[orderRef] tracking page:
 *   1. Unauthenticated page for a real order — status, items, history; no PII
 *   2. Dispatched order with Shippo tracking shows a real carrier link
 *   3. Unknown order_ref is a clean not-found
 *   4. Another business's order_ref only exposes that order's own safe fields
 *   5. Tracking URL is in fulfil/dispatch WhatsApp copy and dashboard detail
 *
 * Run:
 *   node scripts/verify-tracking.mjs
 *   BASE_URL=https://tradeflow-tau-blush.vercel.app node scripts/verify-tracking.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const EK_EMAIL = "sgkiket@gmail.com";
const APP_ORIGIN = "https://tradeflow-tau-blush.vercel.app";

const SENSITIVE_FIELD_NAMES = [
  "stripe_payment_intent_id",
  "stripe_checkout_session_id",
  "stripe_connected_account_id",
  "phone_e164",
  "shipping_address",
  "dispatch_label_url",
  "shippo_shipment_id",
  "shippo_transaction_id",
  "customer_id",
  "business_id",
  "owner_user_id",
  "whatsapp_phone_e164",
  "dispatch_address_line1",
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

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonClient = createClient(url, anon, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function leakedSensitive(payload, extraForbidden = []) {
  const haystack = payload.toLowerCase();
  const hits = [];
  for (const field of SENSITIVE_FIELD_NAMES) {
    if (haystack.includes(field.toLowerCase())) hits.push(field);
  }
  for (const value of extraForbidden) {
    if (value && payload.includes(value)) hits.push(value);
  }
  return hits;
}

async function fetchPublic(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: "text/html,application/xhtml+xml" },
    redirect: "manual",
    cache: "no-store",
  });
  const body = await response.text();
  return { status: response.status, body };
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

function sourceContainsTracking() {
  const fulfil = readFileSync(resolve(root, "src/lib/orders/fulfil-order.ts"), "utf8");
  const dispatch = readFileSync(
    resolve(root, "src/lib/orders/dispatch-order.ts"),
    "utf8",
  );
  return (
    fulfil.includes("orderTrackingUrl") &&
    fulfil.includes("Track your order:") &&
    dispatch.includes("orderTrackingUrl") &&
    dispatch.includes("Track your order:")
  );
}

async function main() {
  const { data: ek } = await admin
    .from("businesses")
    .select("id, name")
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  if (!ek) throw new Error("EK-Pousser_D not found");

  const { data: dispatched } = await admin
    .from("orders")
    .select(
      "id, order_ref, status, total_pence, refunded_amount_pence, created_at, customer_id, business_id, dispatch_tracking_number, dispatch_carrier, dispatch_label_url, shippo_transaction_id, stripe_payment_intent_id, shipping_address",
    )
    .eq("business_id", ek.id)
    .eq("status", "DISPATCHED")
    .not("dispatch_tracking_number", "is", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: anyEk } = dispatched
    ? { data: dispatched }
    : await admin
        .from("orders")
        .select(
          "id, order_ref, status, total_pence, refunded_amount_pence, created_at, customer_id, business_id, dispatch_tracking_number, dispatch_carrier, dispatch_label_url, shippo_transaction_id, stripe_payment_intent_id, shipping_address",
        )
        .eq("business_id", ek.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

  const primary = dispatched ?? anyEk;
  if (!primary) throw new Error("No EK-Pousser_D orders found");

  const { data: customer } = await admin
    .from("customers")
    .select("id, phone_e164, name")
    .eq("id", primary.customer_id)
    .maybeSingle();

  const { data: items } = await admin
    .from("order_items")
    .select("quantity, product_variants(label, products(name))")
    .eq("order_id", primary.id);

  const { data: otherBiz } = await admin
    .from("businesses")
    .select("id, name")
    .neq("id", ek.id)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  let otherOrder = null;
  let createdIsolationOrder = false;
  if (otherBiz) {
    const { data } = await admin
      .from("orders")
      .select("id, order_ref, status, customer_id, business_id")
      .eq("business_id", otherBiz.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    otherOrder = data;
    if (!otherOrder) {
      const isolationRef = `TF-ISO-${Date.now().toString(16).toUpperCase()}`;
      const { data: inserted, error: insertError } = await admin
        .from("orders")
        .insert({
          business_id: otherBiz.id,
          channel: "whatsapp",
          status: "PAID",
          total_pence: 100,
          order_ref: isolationRef,
        })
        .select("id, order_ref, status, customer_id, business_id")
        .single();
      if (insertError) throw new Error(insertError.message);
      otherOrder = inserted;
      createdIsolationOrder = true;
    }
  }

  const productNames = (items ?? [])
    .map((row) => {
      const variant = Array.isArray(row.product_variants)
        ? row.product_variants[0]
        : row.product_variants;
      const product = Array.isArray(variant?.products)
        ? variant.products[0]
        : variant?.products;
      return product?.name;
    })
    .filter(Boolean);

  console.log(`BASE ${BASE}`);
  console.log(
    `Primary ${primary.order_ref} status=${primary.status} tracking=${primary.dispatch_tracking_number} carrier=${primary.dispatch_carrier}`,
  );
  if (otherOrder) {
    console.log(`Other ${otherOrder.order_ref} business=${otherBiz.name}`);
  }
  console.log("");

  const { data: anonRow } = await anonClient
    .from("orders")
    .select("id, order_ref, stripe_payment_intent_id")
    .eq("order_ref", primary.order_ref)
    .maybeSingle();
  record(
    "RLS: anon still cannot read orders by order_ref",
    !anonRow,
    `anonRow=${JSON.stringify(anonRow)}`,
  );

  const page = await fetchPublic(`/t/${encodeURIComponent(primary.order_ref)}`);
  const forbidden = [
    primary.id,
    primary.customer_id,
    primary.business_id,
    customer?.phone_e164,
    primary.stripe_payment_intent_id,
    primary.dispatch_label_url,
    primary.shippo_transaction_id,
    otherOrder?.order_ref,
    otherOrder?.id,
  ].filter(Boolean);
  const leaks = leakedSensitive(page.body, forbidden);
  const itemsVisible = productNames.every((name) => page.body.includes(name));
  const pagePass =
    page.status === 200 &&
    page.body.includes(primary.order_ref) &&
    itemsVisible &&
    leaks.length === 0;
  record(
    "1. Unauthenticated /t/{order_ref} shows this order only, with no sensitive payload",
    pagePass,
    `status=${page.status} leaks=${JSON.stringify(leaks)} products=${productNames.join("|")} len=${page.body.length}`,
  );

  const trackingNumber = primary.dispatch_tracking_number;
  const carrier = primary.dispatch_carrier ?? "";
  const hasCarrierLink =
    Boolean(trackingNumber) &&
    page.body.includes(trackingNumber) &&
    (/hermes|evri/i.test(carrier) ? page.body.includes("evri.com") : true) &&
    (/usps/i.test(carrier) ? page.body.includes("tools.usps.com") : true) &&
    page.body.includes("Track with");
  const shippoPass = dispatched
    ? page.status === 200 && Boolean(trackingNumber) && hasCarrierLink
    : false;
  record(
    "2. Dispatched Shippo tracking number is shown with a carrier link",
    shippoPass,
    dispatched
      ? `carrier=${carrier} tracking=${trackingNumber} hasLink=${hasCarrierLink}`
      : "No DISPATCHED EK order with a tracking number found",
  );

  const missing = await fetchPublic("/t/TF-DOESNOTEXIST99");
  const missingOk =
    missing.status === 404 &&
    /order not found/i.test(missing.body) &&
    !/internal server error/i.test(missing.body);
  record(
    "3. Unknown order_ref is a clean not-found state",
    missingOk,
    `status=${missing.status} custom=${/order not found/i.test(missing.body)}`,
  );

  if (!otherOrder) {
    record(
      "4. Other-tenant order_ref only exposes that order's own safe fields",
      false,
      "No other-business found to compare",
    );
  } else {
    try {
      const otherPage = await fetchPublic(
        `/t/${encodeURIComponent(otherOrder.order_ref)}`,
      );
      let otherPhone = null;
      if (otherOrder.customer_id) {
        const { data: otherCustomer } = await admin
          .from("customers")
          .select("phone_e164")
          .eq("id", otherOrder.customer_id)
          .maybeSingle();
        otherPhone = otherCustomer?.phone_e164 ?? null;
      }
      const otherLeaks = leakedSensitive(otherPage.body, [
        otherOrder.id,
        otherOrder.customer_id,
        otherOrder.business_id,
        otherPhone,
        primary.order_ref,
        primary.id,
        customer?.phone_e164,
      ]);
      const isolated =
        otherPage.status === 200 &&
        otherPage.body.includes(otherOrder.order_ref) &&
        !otherPage.body.includes(primary.order_ref) &&
        otherLeaks.length === 0 &&
        !page.body.includes(otherOrder.order_ref);
      record(
        "4. Other-tenant order_ref only exposes that order's own safe fields",
        isolated,
        `otherStatus=${otherPage.status} otherRef=${otherOrder.order_ref} leaks=${JSON.stringify(otherLeaks)}`,
      );
    } finally {
      if (createdIsolationOrder && otherOrder?.id) {
        await admin.from("orders").delete().eq("id", otherOrder.id);
      }
    }
  }

  const expectedUrl = `${APP_ORIGIN}/t/${encodeURIComponent(primary.order_ref)}`;
  const cookies = await mintEkCookies();
  const detail = await fetch(`${BASE}/dashboard/orders/${primary.id}`, {
    headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    redirect: "manual",
    cache: "no-store",
  });
  const detailHtml = await detail.text();
  const dashboardPass =
    detail.status === 200 &&
    detailHtml.includes("Buyer tracking page") &&
    detailHtml.includes(expectedUrl);
  const messagesPass = sourceContainsTracking();
  record(
    "5. Tracking URL is in fulfil/dispatch WhatsApp copy and dashboard order detail",
    dashboardPass && messagesPass,
    `dashboard=${detail.status} urlInDashboard=${detailHtml.includes(expectedUrl)} sourceMessages=${messagesPass} expected=${expectedUrl}`,
  );

  console.log("\n========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
