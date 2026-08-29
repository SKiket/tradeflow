/**
 * Verifies AWAITING_PAYMENT intercept: cancel + mid-flow change must not
 * leave a second live order. Case-d (PENDING_CONFIRMATION correction) must
 * still update the same draft.
 *
 *  1. Confirm to AWAITING_PAYMENT, then "actually cancel that"
 *  2. Confirm to AWAITING_PAYMENT, then change items
 *  3. (browser) expired Checkout URL is no longer payable — run after this
 *     script prints checkoutUrlForUiCheck
 *  4. Case d regression: size correction on a still-PENDING_CONFIRMATION draft
 *
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-awaiting-payment-change.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447733308706";

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
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const STRIPE_SECRET = env.STRIPE_SECRET_KEY;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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
    ProfileName: "Awaiting Payment Change Tester",
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

async function stripeSession(sessionId) {
  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
    { headers: { Authorization: `Bearer ${STRIPE_SECRET}` } },
  );
  return response.json();
}

async function reservedOf(variantId) {
  const { data } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", variantId)
    .maybeSingle();
  return data?.reserved_quantity ?? 0;
}

async function liveOrdersOnThread(businessId, threadId) {
  const { data } = await admin
    .from("orders")
    .select("id, status, order_ref, thread_id")
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .in("status", ["PENDING_CONFIRMATION", "AWAITING_PAYMENT"])
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  return data ?? [];
}

async function allOrdersOnThread(businessId, threadId) {
  const { data } = await admin
    .from("orders")
    .select(
      "id, status, order_ref, thread_id, stripe_checkout_session_id, reserved_until, order_items(quantity, product_variant_id)",
    )
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  return data ?? [];
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
            reserved_quantity: Math.max(
              0,
              (variant.reserved_quantity ?? 0) - item.quantity,
            ),
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
  await admin.from("messages").delete().in("customer_id", ids);
}

async function flowToAwaitingPayment() {
  const draftSend = await sendWhatsApp("I'd like 2 of the blue mug");
  await sleep(4000);
  const yesSend = await sendWhatsApp("yes");
  await sleep(4000);
  return { draftSend, yesSend };
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select(
      "id, name, whatsapp_phone_e164, stripe_connected_account_id, stripe_charges_enabled",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (!business.stripe_connected_account_id || !business.stripe_charges_enabled) {
    throw new Error("Business Stripe Connect not ready");
  }

  let { data: products } = await admin
    .from("products")
    .select(
      "id, name, price_pence, product_variants(id, label, stock_quantity, reserved_quantity, track_inventory, deleted_at)",
    )
    .eq("business_id", business.id)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("description", "%[order_parse_seed]%");

  if (!products?.length) {
    const { spawnSync } = await import("node:child_process");
    spawnSync("node", ["scripts/seed-ek-pousser-catalog.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    const refreshed = await admin
      .from("products")
      .select(
        "id, name, price_pence, product_variants(id, label, stock_quantity, reserved_quantity, track_inventory, deleted_at)",
      )
      .eq("business_id", business.id)
      .eq("active", true)
      .is("deleted_at", null)
      .ilike("description", "%[order_parse_seed]%");
    products = refreshed.data;
  }

  const blueMug = products.find((p) => /blue mug/i.test(p.name));
  const mugVariant = (blueMug?.product_variants ?? []).find((v) => !v.deleted_at);
  const sneakers = products.find((p) => /sneaker/i.test(p.name));
  const size10 = (sneakers?.product_variants ?? []).find(
    (v) => !v.deleted_at && /10/.test(v.label ?? ""),
  );
  const size11 = (sneakers?.product_variants ?? []).find(
    (v) => !v.deleted_at && /11/.test(v.label ?? ""),
  );
  if (!mugVariant) throw new Error("Blue mug variant not found");
  if (!size10 || !size11) throw new Error("Sneaker size 10/11 variants not found");

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Stripe connected: ${business.stripe_connected_account_id}\n`);

  let checkoutUrlForUiCheck = null;
  let checkoutSessionIdForUiCheck = null;

  // ========== Test 1: cancel after AWAITING_PAYMENT ==========
  await cleanBuyerState(business.id);
  const reservedBefore1 = await reservedOf(mugVariant.id);
  const flow1 = await flowToAwaitingPayment();
  const orderId1 = flow1.yesSend.json.reply?.orderId;
  const sessionId1 = flow1.yesSend.json.reply?.checkoutSessionId;
  const checkoutUrl1 = flow1.yesSend.json.reply?.checkoutUrl;
  const threadId1 = flow1.yesSend.json.threadId ?? flow1.draftSend.json.threadId;

  const { data: awaiting1 } = await admin
    .from("orders")
    .select("id, status, reserved_until, stripe_checkout_session_id")
    .eq("id", orderId1)
    .maybeSingle();
  const reservedHeld1 = await reservedOf(mugVariant.id);

  const cancelSend = await sendWhatsApp("actually cancel that");
  await sleep(4000);

  const { data: cancelled1 } = await admin
    .from("orders")
    .select("id, status, reserved_until, stripe_checkout_session_id, thread_id")
    .eq("id", orderId1)
    .maybeSingle();
  const reservedAfter1 = await reservedOf(mugVariant.id);
  const stripe1 = sessionId1 ? await stripeSession(sessionId1) : { status: null };
  const live1 = threadId1 ? await liveOrdersOnThread(business.id, threadId1) : [];
  const reply1 = cancelSend.json.reply;
  const buyerNotifyOk =
    typeof reply1?.outboundMessageId === "string" ||
    (typeof reply1?.error === "string" && /50 daily messages/i.test(reply1.error));

  const t1Pass =
    flow1.yesSend.json.reply?.replyAction === "confirmed" &&
    awaiting1?.status === "AWAITING_PAYMENT" &&
    reservedHeld1 === reservedBefore1 + 2 &&
    cancelSend.status === 200 &&
    reply1?.replyAction === "cancelled" &&
    reply1?.previousStatus === "AWAITING_PAYMENT" &&
    cancelled1?.status === "CANCELLED" &&
    cancelled1?.reserved_until == null &&
    reservedAfter1 === reservedBefore1 &&
    stripe1.status === "expired" &&
    live1.length === 0 &&
    buyerNotifyOk;

  record(
    "Test 1: AWAITING_PAYMENT + 'actually cancel that' → released, session expired, CANCELLED",
    t1Pass,
    `awaiting=${JSON.stringify(awaiting1)}\ncancelled=${JSON.stringify(cancelled1)}\nstripe.status=${stripe1.status}\nreserved ${reservedBefore1} → ${reservedHeld1} → ${reservedAfter1}\nreply=${JSON.stringify(reply1)}\nlive=${JSON.stringify(live1)}`,
  );

  if (checkoutUrl1) {
    checkoutUrlForUiCheck = checkoutUrl1;
    checkoutSessionIdForUiCheck = sessionId1;
  }

  // ========== Test 2: change after AWAITING_PAYMENT ==========
  await cleanBuyerState(business.id);
  const reservedBefore2 = await reservedOf(mugVariant.id);
  const flow2 = await flowToAwaitingPayment();
  const orderId2 = flow2.yesSend.json.reply?.orderId;
  const sessionId2 = flow2.yesSend.json.reply?.checkoutSessionId;
  const threadId2 = flow2.yesSend.json.threadId ?? flow2.draftSend.json.threadId;

  const changeSend = await sendWhatsApp(
    "actually I want the weekend sneakers in size 10 instead",
  );
  await sleep(5000);

  const { data: old2 } = await admin
    .from("orders")
    .select("id, status, reserved_until, stripe_checkout_session_id")
    .eq("id", orderId2)
    .maybeSingle();
  const stripe2 = sessionId2 ? await stripeSession(sessionId2) : { status: null };
  const reservedAfter2 = await reservedOf(mugVariant.id);
  const live2 = threadId2 ? await liveOrdersOnThread(business.id, threadId2) : [];
  const all2 = threadId2 ? await allOrdersOnThread(business.id, threadId2) : [];
  const draft2 = changeSend.json.draft;
  const newDraft = live2.find((o) => o.status === "PENDING_CONFIRMATION");
  const { data: newItems } = newDraft
    ? await admin
        .from("order_items")
        .select("quantity, product_variant_id")
        .eq("order_id", newDraft.id)
    : { data: [] };

  const t2Pass =
    changeSend.status === 200 &&
    changeSend.json.reply == null &&
    draft2?.action === "draft_created" &&
    draft2?.supersededOrderId === orderId2 &&
    old2?.status === "CANCELLED" &&
    old2?.reserved_until == null &&
    stripe2.status === "expired" &&
    reservedAfter2 === reservedBefore2 &&
    live2.length === 1 &&
    live2[0].status === "PENDING_CONFIRMATION" &&
    live2[0].id !== orderId2 &&
    (newItems ?? []).length === 1 &&
    newItems[0].product_variant_id === size10.id &&
    typeof draft2?.confirmationMessage === "string" &&
    /YES to confirm/i.test(draft2.confirmationMessage);

  record(
    "Test 2: AWAITING_PAYMENT + item change → old cancelled/expired, one new PENDING_CONFIRMATION",
    t2Pass,
    `old=${JSON.stringify(old2)}\nstripe.status=${stripe2.status}\ndraft=${JSON.stringify(draft2)}\nlive=${JSON.stringify(live2)}\nnewItems=${JSON.stringify(newItems)}\nallOnThread=${JSON.stringify(all2, null, 2)}`,
  );

  if (!checkoutUrlForUiCheck && flow2.yesSend.json.reply?.checkoutUrl) {
    checkoutUrlForUiCheck = flow2.yesSend.json.reply.checkoutUrl;
    checkoutSessionIdForUiCheck = sessionId2;
  }

  // ========== Case d regression (still PENDING_CONFIRMATION) ==========
  await cleanBuyerState(business.id);
  const d1 = await sendWhatsApp("I'd like the weekend sneakers in size 10");
  await sleep(4000);
  const d1Draft = d1.json.draft;
  const d1OrderId = d1Draft?.orderId;
  const d2 = await sendWhatsApp("actually make it size 11");
  await sleep(4000);
  const d2Draft = d2.json.draft;
  const dThread = d1.json.threadId;
  const { data: dOrders } = await admin
    .from("orders")
    .select(
      "id, status, thread_id, order_items(id, quantity, product_variant_id)",
    )
    .eq("business_id", business.id)
    .eq("thread_id", dThread)
    .eq("status", "PENDING_CONFIRMATION");
  const caseDPass =
    d1Draft?.action === "draft_created" &&
    d2Draft?.action === "draft_updated" &&
    d2Draft?.orderId === d1OrderId &&
    (dOrders ?? []).length === 1 &&
    dOrders[0].id === d1OrderId &&
    dOrders[0].order_items?.length === 1 &&
    dOrders[0].order_items[0].product_variant_id === size11.id;

  record(
    "Case d regression: PENDING_CONFIRMATION size correction updates SAME draft",
    caseDPass,
    `d1=${JSON.stringify(d1Draft)}\nd2=${JSON.stringify(d2Draft)}\norders=${JSON.stringify(dOrders, null, 2)}`,
  );

  // Recreate a leftover query on the change-flow thread (cleaned before case d).
  // Re-query is empty after clean; print the Test 2 snapshot as the orphan check.
  console.log("\n--- Live-order query after Test 2 (change flow) ---");
  console.log(JSON.stringify(live2, null, 2));
  console.log("\n--- All orders on Test 2 thread ---");
  console.log(JSON.stringify(all2, null, 2));

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  if (checkoutUrlForUiCheck) {
    console.log("\ncheckoutUrlForUiCheck=" + checkoutUrlForUiCheck);
    console.log("checkoutSessionIdForUiCheck=" + checkoutSessionIdForUiCheck);
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
