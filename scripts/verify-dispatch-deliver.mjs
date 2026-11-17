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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  createAdmin,
  deleteOrdersByIds,
  deleteTestBusiness,
  ensureSeedCatalog,
  hashTag,
  liveVariants,
  loadVerifyEnv,
  newRunId,
  phoneFromRunId,
} from "./lib/verify-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const env = loadVerifyEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createAdmin({ allowPilotWrites: true });
const runId = newRunId("disp");

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
  console.log(`runId=${runId}`);
  const createdOrderIds = [];
  let otherEmail = null;
  let exitCode = 1;

  const { data: business } = await admin
    .from("businesses")
    .select("id, name, owner_user_id")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) throw new Error("Owner email not found");

  const buyerPhone = phoneFromRunId(runId, 0);
  let { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", buyerPhone)
    .maybeSingle();
  if (!customer) {
    const inserted = await admin
      .from("customers")
      .insert({
        business_id: business.id,
        phone_e164: buyerPhone,
        name: `Dispatch Verify ${runId}`,
      })
      .select("id")
      .single();
    customer = inserted.data;
  }
  const customerId = customer.id;

  const products = await ensureSeedCatalog(admin, business.id, {
    select: "id, name, price_pence, product_variants(id, deleted_at)",
  });
  const mug = products.find((p) => /blue mug/i.test(p.name)) ?? products[0];
  const variant = liveVariants(mug)[0];
  if (!variant) throw new Error("No catalog variant");
  const unitPrice = mug.price_pence ?? 1200;

  async function createPaidOrder(suffix) {
    const orderRef = `DP${hashTag(`${runId}:${suffix}`).slice(0, 8)}${Date.now().toString(36)}${suffix}`.toUpperCase().slice(0, 28);
    const { data: order, error } = await admin
      .from("orders")
      .insert({
        business_id: business.id,
        customer_id: customerId,
        channel: "whatsapp",
        status: "PAID",
        total_pence: unitPrice,
        order_ref: orderRef,
        shipping_address: BAKER_ST,
      })
      .select("id, order_ref")
      .single();
    if (error || !order) throw new Error(error?.message ?? "order create failed");
    createdOrderIds.push(order.id);
    await admin.from("order_items").insert({
      order_id: order.id,
      business_id: business.id,
      product_variant_id: variant.id,
      quantity: 1,
      unit_price_pence: unitPrice,
    });
    return order;
  }

  try {
  const paidOrder = await createPaidOrder("A");
  const orderId = paidOrder.id;
  const orderRef = paidOrder.order_ref;

  const ownerToken = await signIn(ownerEmail);

  const paidOnlyOrder = await createPaidOrder("B");
  const paidOnlyId = paidOnlyOrder.id;

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
  otherEmail = `other-tenant-${runId}@tradeflow-test.local`;
  await cleanupOtherUser(otherEmail);
  const { data: otherUser } = await admin.auth.admin.createUser({
    email: otherEmail,
    email_confirm: true,
  });
  const { data: otherBiz } = await admin
    .from("businesses")
    .insert({
      owner_user_id: otherUser.user.id,
      name: `Other Tenant Shop ${runId}`,
      slug: `other-${runId}`.slice(0, 40),
      dispatch_address_line1: "2 Other St",
      dispatch_city: "London",
      dispatch_postcode: "E2 2BB",
      payout_account_holder_name: "Other",
      payout_sort_code: "11-22-33",
      payout_account_number: "87654321",
    })
    .select("id")
    .single();
  const otherToken = await signIn(otherEmail);
  const crossTenant = await apiPost(otherToken, `/api/orders/${orderId}/dispatch`, {
    trackingNumber: "HACK",
  });

  const case3Pass = crossTenant.status === 404;
  record(
    "Case 3: other tenant dispatch → rejected (404)",
    case3Pass,
    `status=${crossTenant.status} body=${JSON.stringify(crossTenant.json)}`,
  );
  if (otherBiz?.id) {
    await deleteTestBusiness(admin, otherBiz.id, { ownerUserId: otherUser.user.id });
  } else {
    await cleanupOtherUser(otherEmail);
  }
  otherEmail = null;

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
  exitCode = allPassed ? 0 : 1;
  } finally {
    await deleteOrdersByIds(admin, createdOrderIds);
    if (otherEmail) await cleanupOtherUser(otherEmail);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exit(1);
  });
