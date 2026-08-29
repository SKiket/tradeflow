/**
 * Verifies real Shippo rate-shopping and label purchase on dispatch.
 *
 *  1. PAID order with shipping address → real rates (not fabricated)
 *  2. Purchase selected rate → real Shippo transaction + tracking + label URL
 *  3. Buyer WhatsApp includes the real tracking number/carrier
 *  4. Invalid postcode → clear error, order stays PAID
 *  5. Label URL is reachable (download/view)
 *
 * Requires Next.js dev server. Run:
 *   node scripts/verify-shippo-dispatch.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const BAKER_ST = {
  line1: "221B Baker Street",
  line2: "Flat 2",
  city: "London",
  postcode: "NW1 6XE",
  country: "GB",
};

const BAD_ADDRESS = {
  ...BAKER_ST,
  postcode: "NOT-A-POSTCODE",
};

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
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
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
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function shippoGet(path) {
  const response = await fetch(`https://api.goshippo.com${path}`, {
    headers: {
      Authorization: `ShippoToken ${env.SHIPPO_API_KEY}`,
      "Shippo-API-Version": "2018-02-08",
    },
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function orderHasItems(orderId) {
  const { count } = await admin
    .from("order_items")
    .select("id", { count: "exact", head: true })
    .eq("order_id", orderId);
  return (count ?? 0) > 0;
}

async function findPaidOrder(businessId) {
  const { data: paid } = await admin
    .from("orders")
    .select("id, order_ref, customer_id, shipping_address, status")
    .eq("business_id", businessId)
    .eq("status", "PAID")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(20);

  for (const row of paid ?? []) {
    if (await orderHasItems(row.id)) return row;
  }

  const { data: later } = await admin
    .from("orders")
    .select("id, order_ref, customer_id, shipping_address, status")
    .eq("business_id", businessId)
    .in("status", ["DISPATCHED", "DELIVERED"])
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(20);

  for (const row of later ?? []) {
    if (!(await orderHasItems(row.id))) continue;
    await admin
      .from("orders")
      .update({
        status: "PAID",
        dispatch_tracking_number: null,
        dispatch_carrier: null,
        dispatch_label_url: null,
        shippo_shipment_id: null,
        shippo_transaction_id: null,
      })
      .eq("id", row.id);
    return { ...row, status: "PAID" };
  }

  return null;
}

async function main() {
  if (!env.SHIPPO_API_KEY?.trim()) {
    throw new Error("SHIPPO_API_KEY missing from .env.local");
  }

  const { data: business } = await admin
    .from("businesses")
    .select(
      "id, name, owner_user_id, dispatch_address_line1, dispatch_city, dispatch_postcode",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");

  if (
    !business.dispatch_address_line1?.trim() ||
    !business.dispatch_city?.trim() ||
    !business.dispatch_postcode?.trim()
  ) {
    await admin
      .from("businesses")
      .update({
        dispatch_address_line1: "10 Downing Street",
        dispatch_city: "London",
        dispatch_postcode: "SW1A 2AA",
      })
      .eq("id", business.id);
    console.log("Set missing dispatch address on EK-Pousser_D for this run.");
  }

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) throw new Error("Owner email not found");

  const order = await findPaidOrder(business.id);
  if (!order) throw new Error("No PAID (or resettable) order with line items");

  await admin
    .from("orders")
    .update({ shipping_address: BAKER_ST })
    .eq("id", order.id);

  const ownerToken = await signIn(ownerEmail);

  // ----- Test 4 first: fail closed on malformed postcode -----
  await admin
    .from("orders")
    .update({ shipping_address: BAD_ADDRESS })
    .eq("id", order.id);

  const badQuote = await apiPost(
    ownerToken,
    `/api/orders/${order.id}/shipping-rates`,
    {},
  );
  const { data: afterBad } = await admin
    .from("orders")
    .select("status, dispatch_tracking_number, shippo_transaction_id")
    .eq("id", order.id)
    .single();

  const test4Pass =
    badQuote.status === 400 &&
    typeof badQuote.json.error === "string" &&
    badQuote.json.error.length > 0 &&
    afterBad?.status === "PAID" &&
    !afterBad.dispatch_tracking_number &&
    !afterBad.shippo_transaction_id;
  record(
    "4. Invalid postcode → error, order stays PAID",
    test4Pass,
    `status=${badQuote.status} error=${badQuote.json.error} orderStatus=${afterBad?.status}`,
  );

  await admin
    .from("orders")
    .update({ shipping_address: BAKER_ST })
    .eq("id", order.id);

  // ----- Test 1: real rates -----
  const quoted = await apiPost(
    ownerToken,
    `/api/orders/${order.id}/shipping-rates`,
    {},
  );
  const rates = Array.isArray(quoted.json.rates) ? quoted.json.rates : [];
  const cheapest = rates[0];
  const ratesLookReal =
    quoted.status === 200 &&
    typeof quoted.json.shipmentId === "string" &&
    quoted.json.shipmentId.length > 8 &&
    rates.length >= 1 &&
    rates.length <= 4 &&
    Boolean(cheapest?.objectId) &&
    Boolean(cheapest?.carrier) &&
    Boolean(cheapest?.amount) &&
    rates.every((rate) => typeof rate.objectId === "string" && rate.objectId.length > 8);

  record(
    "1. Real Shippo rates fetched and displayed (not fabricated)",
    ratesLookReal,
    `status=${quoted.status} error=${quoted.json.error ?? ""} shipmentId=${quoted.json.shipmentId} weightGrams=${quoted.json.weightGrams} rates=${JSON.stringify(rates)} body=${JSON.stringify(quoted.json)}`,
  );

  if (!ratesLookReal || !cheapest) {
    throw new Error("Cannot continue — rates were not returned");
  }

  // ----- Test 2: purchase label -----
  const purchased = await apiPost(ownerToken, `/api/orders/${order.id}/dispatch`, {
    rateObjectId: cheapest.objectId,
    shipmentId: quoted.json.shipmentId,
    carrier: cheapest.carrier,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const { data: dispatched } = await admin
    .from("orders")
    .select(
      "status, dispatch_tracking_number, dispatch_carrier, dispatch_label_url, shippo_shipment_id, shippo_transaction_id",
    )
    .eq("id", order.id)
    .single();

  const txnId = dispatched?.shippo_transaction_id;
  const shippoTxn = txnId ? await shippoGet(`/transactions/${txnId}`) : { status: 0, json: {} };
  const remoteOk =
    shippoTxn.status === 200 &&
    shippoTxn.json.object_id === txnId &&
    (shippoTxn.json.status === "SUCCESS" || Boolean(shippoTxn.json.tracking_number));

  const test2Pass =
    purchased.status === 200 &&
    purchased.json.action === "dispatched" &&
    dispatched?.status === "DISPATCHED" &&
    Boolean(dispatched.dispatch_tracking_number) &&
    Boolean(dispatched.dispatch_label_url) &&
    Boolean(dispatched.shippo_shipment_id) &&
    Boolean(txnId) &&
    remoteOk;
  record(
    "2. Real Shippo transaction created; tracking + label stored",
    test2Pass,
    `dispatch=${purchased.status} action=${purchased.json.action}\nshipmentId=${dispatched?.shippo_shipment_id}\ntransactionId=${txnId}\ntracking=${dispatched?.dispatch_tracking_number}\ncarrier=${dispatched?.dispatch_carrier}\nlabel=${dispatched?.dispatch_label_url}\nshippoStatus=${shippoTxn.json.status} shippoTracking=${shippoTxn.json.tracking_number}`,
  );

  // ----- Test 3: WhatsApp uses real tracking -----
  const { data: dispatchMsg } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("customer_id", order.customer_id)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${order.order_ref}%dispatched%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const msg = dispatchMsg?.normalised_text ?? "";
  const test3Pass =
    Boolean(dispatched?.dispatch_tracking_number) &&
    msg.includes(dispatched.dispatch_tracking_number) &&
    (!dispatched.dispatch_carrier || msg.includes(dispatched.dispatch_carrier));
  record(
    "3. Buyer WhatsApp dispatch message contains real tracking/carrier",
    test3Pass,
    msg || "(no outbound dispatch message captured)",
  );

  // ----- Test 5: label URL works -----
  let labelStatus = 0;
  let labelType = "";
  if (dispatched?.dispatch_label_url) {
    const labelRes = await fetch(dispatched.dispatch_label_url, {
      method: "GET",
      redirect: "follow",
    });
    labelStatus = labelRes.status;
    labelType = labelRes.headers.get("content-type") ?? "";
    await labelRes.arrayBuffer();
  }
  const test5Pass =
    Boolean(dispatched?.dispatch_label_url) &&
    labelStatus >= 200 &&
    labelStatus < 400;
  record(
    "5. Label link/download works from stored Shippo URL",
    test5Pass,
    `url=${dispatched?.dispatch_label_url} http=${labelStatus} content-type=${labelType}`,
  );

  console.log("\n========================================");
  console.log("Shippo IDs for dashboard cross-check:");
  console.log(`  order_ref:     ${order.order_ref}`);
  console.log(`  order_id:      ${order.id}`);
  console.log(`  shipment_id:   ${dispatched?.shippo_shipment_id ?? "(none)"}`);
  console.log(`  transaction_id:${txnId ?? "(none)"}`);
  console.log(`  tracking:      ${dispatched?.dispatch_tracking_number ?? "(none)"}`);
  console.log(`  carrier:       ${dispatched?.dispatch_carrier ?? "(none)"}`);
  console.log("========================================");

  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
