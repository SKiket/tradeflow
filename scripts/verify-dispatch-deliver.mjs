/**
 * Verifies POST /api/orders/[orderId]/dispatch and /deliver (Step 12).
 *
 * Cases:
 *  1. Owner dispatches PAID order with tracking → DISPATCHED + WhatsApp
 *  2. Repeat dispatch → idempotent no-op, no duplicate WhatsApp
 *  3. Different tenant cannot dispatch → 404
 *  4. Deliver DISPATCHED order → DELIVERED + WhatsApp
 *  5. Deliver PAID (never dispatched) → rejected
 *
 * Requires Next.js dev server. Run:
 *   node scripts/verify-dispatch-deliver.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

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
let dispatchMessageText = "";
let deliverMessageText = "";

function record(name, passed, detail) {
  results.push({ name, passed });
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

async function countDispatchMessages(customerId, orderRef) {
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text")
    .eq("customer_id", customerId)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${orderRef}%dispatched%`);
  return data ?? [];
}

const BAKER_ST = {
  line1: "221B Baker Street",
  line2: "Flat 2",
  city: "London",
  postcode: "NW1 6XE",
  country: "GB",
};

async function quoteAndDispatch(token, orderId) {
  const quoted = await apiPost(token, `/api/orders/${orderId}/shipping-rates`, {});
  if (quoted.status !== 200 || !quoted.json.rates?.[0]) {
    return { quoted, dispatch: null, rate: null };
  }
  const rate = quoted.json.rates[0];
  const dispatch = await apiPost(token, `/api/orders/${orderId}/dispatch`, {
    rateObjectId: rate.objectId,
    shipmentId: quoted.json.shipmentId,
    carrier: rate.carrier,
  });
  return { quoted, dispatch, rate };
}

async function cleanupOtherUser(email) {
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users?.find((u) => u.email === email);
  if (!user) return;
  await admin.from("businesses").delete().eq("owner_user_id", user.id);
  await admin.auth.admin.deleteUser(user.id);
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, owner_user_id")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) throw new Error("Owner email not found");

  // Use a dedicated PAID order for this test run
  const { data: paidOrder } = await admin
    .from("orders")
    .select("id, order_ref, status, customer_id")
    .eq("business_id", business.id)
    .eq("status", "PAID")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let orderId = paidOrder?.id;
  let orderRef = paidOrder?.order_ref;
  let customerId = paidOrder?.customer_id;

  if (!orderId) {
    const { data: anyOrder } = await admin
      .from("orders")
      .select("id, order_ref, status, customer_id")
      .eq("business_id", business.id)
      .in("status", ["DISPATCHED", "DELIVERED"])
      .limit(1)
      .maybeSingle();
    if (anyOrder) {
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
        .eq("id", anyOrder.id);
      orderId = anyOrder.id;
      orderRef = anyOrder.order_ref;
      customerId = anyOrder.customer_id;
    }
  }

  if (!orderId) throw new Error("No PAID order available for testing");

  await admin
    .from("orders")
    .update({ shipping_address: BAKER_ST })
    .eq("id", orderId);

  const ownerToken = await signIn(ownerEmail);

  // Separate PAID order for case 5 (never dispatch)
  const { data: paidOnly } = await admin
    .from("orders")
    .select("id, order_ref")
    .eq("business_id", business.id)
    .eq("status", "PAID")
    .neq("id", orderId)
    .limit(1)
    .maybeSingle();

  let paidOnlyId = paidOnly?.id;
  if (!paidOnlyId) {
    const { data: created } = await admin
      .from("orders")
      .insert({
        business_id: business.id,
        customer_id: customerId,
        channel: "whatsapp",
        status: "PAID",
        total_pence: 1200,
        order_ref: `TF-DISPTEST-${Date.now().toString(16).toUpperCase()}`,
      })
      .select("id")
      .single();
    paidOnlyId = created?.id;
  }

  // ========== Case 1: dispatch with purchased Shippo label ==========
  const { quoted, dispatch: dispatch1, rate } = await quoteAndDispatch(
    ownerToken,
    orderId,
  );
  await new Promise((r) => setTimeout(r, 1500));

  const { data: orderAfterDispatch } = await admin
    .from("orders")
    .select(
      "status, dispatch_tracking_number, dispatch_carrier, dispatch_label_url, shippo_transaction_id",
    )
    .eq("id", orderId)
    .single();
  const { data: history1 } = await admin
    .from("order_status_history")
    .select("from_status, to_status")
    .eq("order_id", orderId)
    .eq("to_status", "DISPATCHED");
  const { data: dispatchMsg } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("customer_id", customerId)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${orderRef}%dispatched%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  dispatchMessageText = dispatchMsg?.normalised_text ?? "";

  const tracking = orderAfterDispatch?.dispatch_tracking_number ?? "";
  const case1Pass =
    dispatch1?.status === 200 &&
    dispatch1.json.action === "dispatched" &&
    orderAfterDispatch?.status === "DISPATCHED" &&
    Boolean(tracking) &&
    Boolean(orderAfterDispatch?.dispatch_label_url) &&
    (history1 ?? []).length >= 1 &&
    dispatchMessageText.includes(tracking);
  record(
    "Case 1: owner dispatch PAID → DISPATCHED + tracking WhatsApp",
    case1Pass,
    `quoted=${quoted.status} rate=${rate?.carrier} ${rate?.service}\nstatus=${dispatch1?.status} body=${JSON.stringify(dispatch1?.json)}\nmsg=${dispatchMessageText}`,
  );

  // ========== Case 2: idempotent dispatch ==========
  const msgsBefore = await countDispatchMessages(customerId, orderRef);
  const dispatch2 = await apiPost(ownerToken, `/api/orders/${orderId}/dispatch`, {
    rateObjectId: "already-dispatched",
  });
  await new Promise((r) => setTimeout(r, 500));
  const msgsAfter = await countDispatchMessages(customerId, orderRef);

  const case2Pass =
    dispatch2.status === 200 &&
    dispatch2.json.action === "no_op" &&
    dispatch2.json.reason === "already_dispatched" &&
    msgsAfter.length === msgsBefore.length;
  record(
    "Case 2: repeat dispatch → idempotent no-op, no duplicate WhatsApp",
    case2Pass,
    `body=${JSON.stringify(dispatch2.json)}\nmsgs ${msgsBefore.length}→${msgsAfter.length}`,
  );

  // ========== Case 3: cross-tenant ==========
  const OTHER_EMAIL = `other-tenant-${Date.now()}@tradeflow-test.local`;
  await cleanupOtherUser(OTHER_EMAIL);
  const { data: otherUser } = await admin.auth.admin.createUser({
    email: OTHER_EMAIL,
    email_confirm: true,
  });
  await admin.from("businesses").insert({
    owner_user_id: otherUser.user.id,
    name: "Other Tenant Shop",
    slug: `other-${Date.now()}`,
    dispatch_address_line1: "2 Other St",
    dispatch_city: "London",
    dispatch_postcode: "E2 2BB",
    payout_account_holder_name: "Other",
    payout_sort_code: "11-22-33",
    payout_account_number: "87654321",
  });
  const otherToken = await signIn(OTHER_EMAIL);
  const crossTenant = await apiPost(otherToken, `/api/orders/${orderId}/dispatch`, {
    trackingNumber: "HACK",
  });

  const case3Pass = crossTenant.status === 404;
  record(
    "Case 3: other tenant dispatch → rejected (404)",
    case3Pass,
    `status=${crossTenant.status} body=${JSON.stringify(crossTenant.json)}`,
  );
  await cleanupOtherUser(OTHER_EMAIL);

  // ========== Case 4: deliver ==========
  const deliver1 = await apiPost(ownerToken, `/api/orders/${orderId}/deliver`);
  await new Promise((r) => setTimeout(r, 1500));

  const { data: orderDelivered } = await admin
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .single();
  const { data: deliverMsg } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("customer_id", customerId)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${orderRef}%delivered%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  deliverMessageText = deliverMsg?.normalised_text ?? "";

  const case4Pass =
    deliver1.status === 200 &&
    deliver1.json.action === "delivered" &&
    orderDelivered?.status === "DELIVERED" &&
    deliverMessageText.includes(orderRef);
  record(
    "Case 4: deliver DISPATCHED → DELIVERED + buyer WhatsApp",
    case4Pass,
    `body=${JSON.stringify(deliver1.json)}\nmsg=${deliverMessageText}`,
  );

  // ========== Case 5: deliver without dispatch ==========
  const deliverEarly = await apiPost(ownerToken, `/api/orders/${paidOnlyId}/deliver`);
  const { data: paidOnlyAfter } = await admin
    .from("orders")
    .select("status")
    .eq("id", paidOnlyId)
    .single();

  const case5Pass =
    deliverEarly.status === 400 &&
    deliverEarly.json.error?.includes("dispatched") &&
    paidOnlyAfter?.status === "PAID";
  record(
    "Case 5: deliver PAID (never dispatched) → rejected",
    case5Pass,
    `status=${deliverEarly.status} body=${JSON.stringify(deliverEarly.json)} orderStatus=${paidOnlyAfter?.status}`,
  );

  console.log("\n========================================");
  console.log("Dispatch WhatsApp message:");
  console.log(dispatchMessageText || "(none captured)");
  console.log("\nDelivery WhatsApp message:");
  console.log(deliverMessageText || "(none captured)");
  console.log("========================================");

  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
