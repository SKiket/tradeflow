/**
 * Verifies Step 10: affirmative reply → stock reservation + Stripe Checkout.
 *
 * TODO(#1): EK-Pousser_D may be pointed at acct_1TsMgBDC7YC3it12 (test account)
 * instead of its real Express account acct_1TsNYxRX0cdBHUMf when charges are
 * disabled — https://github.com/SKiket/tradeflow/issues/1
 *
 * Cases:
 *  1. Reply "yes" → deterministic match, AWAITING_PAYMENT, real Checkout URL
 *  2. (Manual) Open Checkout URL — card + Pay by Bank offered
 *  3. "yeah sounds good" → AI fallback affirmative, same flow
 *  4. "no, cancel" → draft CANCELLED, nothing reserved, no payment link
 *  5. Race: reserve stock elsewhere, confirm draft → rejected at re-check
 *  6. Expiry: backdate reserved_until, trigger sweep → EXPIRED + stock released
 *
 * Requires Next.js dev server. Run:
 *   node scripts/verify-confirm-payment.mjs
 */
import { createHmac } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanBuyerOrders,
  cleanPendingDrafts,
  createAdmin,
  ensureSeedCatalog,
  liveVariants,
  loadVerifyEnv,
  newRunId,
} from "./lib/verify-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447733308706";
/** Second mock phone — triggers business-wide reservation sweep without
 *  cancelling BUYER's AWAITING_PAYMENT via create-draft change flow. */
const SWEEP_BUYER = "+447700900099";

const env = loadVerifyEnv();
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
const admin = createAdmin({ allowPilotWrites: true });
const runId = newRunId("confirm");

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

async function sendWhatsApp(bodyText, fromPhone = BUYER) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${fromPhone}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Confirm Payment Tester",
    Body: bodyText,
    NumMedia: "0",
  };
  const body = new URLSearchParams(full).toString();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-TradeFlow-Verify": "1",
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

  await cleanBuyerOrders(admin, businessId, BUYER);
}

async function buyerCustomerId(businessId) {
  const { data } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", BUYER)
    .maybeSingle();
  return data?.id ?? null;
}

async function createDraft(businessId) {
  // Drop leftover PENDING drafts for this phone so limit(1) cannot pick orphans.
  await cleanPendingDrafts(admin, businessId, BUYER);
  const send = await sendWhatsApp("I'd like 2 of the blue mug");
  await sleep(4000);
  const customerId = await buyerCustomerId(businessId);
  const query = admin
    .from("orders")
    .select("id, status, order_ref, thread_id, order_items(product_variant_id, quantity)")
    .eq("business_id", businessId)
    .eq("status", "PENDING_CONFIRMATION")
    .order("created_at", { ascending: false })
    .limit(1);
  const { data: orders } = customerId
    ? await query.eq("customer_id", customerId)
    : await query;
  return { send, order: orders?.[0] ?? null };
}

async function main() {
  console.log(`runId=${runId}`);
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

  const products = await ensureSeedCatalog(admin, business.id);
  const blueMug = products.find((p) => /blue mug/i.test(p.name));
  const mugVariant = liveVariants(blueMug)[0];
  if (!mugVariant) throw new Error("Blue mug variant not found");

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Stripe connected: ${business.stripe_connected_account_id}\n`);

  let checkoutUrlFromTest1 = null;
  let exitCode = 1;
  try {
  // ========== Case 1: deterministic "yes" ==========
  await cleanBuyerState(business.id);
  await admin
    .from("product_variants")
    .update({ stock_quantity: 25, reserved_quantity: 0, track_inventory: true })
    .eq("id", mugVariant.id);

  const draft1 = await createDraft(business.id);
  const yesSend = await sendWhatsApp("yes");
  await sleep(5000);

  const { data: order1 } = await admin
    .from("orders")
    .select("id, status, reserved_until, stripe_checkout_session_id, order_items(quantity)")
    .eq("id", draft1.order?.id ?? "none")
    .maybeSingle();
  const { data: variantAfter1 } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", mugVariant.id)
    .single();
  const { data: paymentMsg1 } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("direction", "outbound")
    .ilike("normalised_text", "%secure payment link%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const urlMatch = paymentMsg1?.normalised_text?.match(/https:\/\/checkout\.stripe\.com\/[^\s]+/);
  checkoutUrlFromTest1 = urlMatch?.[0] ?? yesSend.json.reply?.checkoutUrl ?? null;

  const case1Pass =
    yesSend.status === 200 &&
    yesSend.json.reply?.replyAction === "confirmed" &&
    yesSend.json.reply?.usedAi === false &&
    yesSend.json.parseStored === false &&
    order1?.status === "AWAITING_PAYMENT" &&
    order1?.reserved_until &&
    order1?.stripe_checkout_session_id &&
    variantAfter1?.reserved_quantity === 2 &&
    !!checkoutUrlFromTest1;
  record(
    "Case 1: 'yes' → deterministic, AWAITING_PAYMENT, stock reserved, Checkout URL",
    case1Pass,
    `reply=${JSON.stringify(yesSend.json.reply)}\norder=${JSON.stringify(order1)}\nreserved=${variantAfter1?.reserved_quantity}\nurl=${checkoutUrlFromTest1}`,
  );

  // ========== Case 3: AI fallback "yeah sounds good" ==========
  await cleanBuyerState(business.id);
  await admin
    .from("product_variants")
    .update({ stock_quantity: 25, reserved_quantity: 0 })
    .eq("id", mugVariant.id);
  const draft3 = await createDraft(business.id);
  const aiSend = await sendWhatsApp("yeah sounds good");
  await sleep(6000);
  const { data: order3 } = await admin
    .from("orders")
    .select("id, status, stripe_checkout_session_id")
    .eq("id", draft3.order?.id ?? "none")
    .maybeSingle();
  const case3Pass =
    aiSend.json.reply?.replyAction === "confirmed" &&
    aiSend.json.reply?.usedAi === true &&
    order3?.status === "AWAITING_PAYMENT" &&
    !!order3?.stripe_checkout_session_id;
  record(
    "Case 3: 'yeah sounds good' → AI affirmative, same flow",
    case3Pass,
    `reply=${JSON.stringify(aiSend.json.reply)}\norder=${JSON.stringify(order3)}`,
  );

  // ========== Case 4: negative cancel ==========
  await cleanBuyerState(business.id);
  await cleanPendingDrafts(admin, business.id, BUYER);
  await admin
    .from("product_variants")
    .update({ reserved_quantity: 0 })
    .eq("id", mugVariant.id);
  const draft4 = await createDraft(business.id);
  const customerId4 = await buyerCustomerId(business.id);
  const noSend = await sendWhatsApp("no, cancel");
  await sleep(3000);
  // Drop any orphan PENDING leftover from other runs before asserts.
  await cleanPendingDrafts(admin, business.id, BUYER);
  const { data: order4 } = await admin
    .from("orders")
    .select("id, status, reserved_until, stripe_checkout_session_id")
    .eq("id", draft4.order?.id ?? "none")
    .maybeSingle();
  const { data: variantAfter4 } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", mugVariant.id)
    .single();
  let payLink4 = [];
  if (customerId4) {
    const { data } = await admin
      .from("messages")
      .select("id")
      .eq("customer_id", customerId4)
      .eq("direction", "outbound")
      .ilike("normalised_text", "%secure payment link%")
      .limit(5);
    payLink4 = data ?? [];
  }
  const case4Pass =
    noSend.json.reply?.replyAction === "cancelled" &&
    order4?.status === "CANCELLED" &&
    !order4?.reserved_until &&
    !order4?.stripe_checkout_session_id &&
    variantAfter4?.reserved_quantity === 0 &&
    payLink4.length === 0;
  record(
    "Case 4: 'no, cancel' → CANCELLED, nothing reserved, no payment link",
    case4Pass,
    `reply=${JSON.stringify(noSend.json.reply)}\norder=${JSON.stringify(order4)}\npayLinks=${payLink4.length}`,
  );

  // ========== Case 5: race condition ==========
  await cleanBuyerState(business.id);
  await admin
    .from("product_variants")
    .update({ stock_quantity: 25, reserved_quantity: 0, track_inventory: true })
    .eq("id", mugVariant.id);
  const draft5 = await createDraft(business.id);
  if (!draft5.order?.id) throw new Error("Case 5: draft not created");
  // Another buyer reserved most stock after the draft was created.
  await admin
    .from("product_variants")
    .update({ reserved_quantity: 24, stock_quantity: 25, track_inventory: true })
    .eq("id", mugVariant.id);
  await sleep(500);
  const raceSend = await sendWhatsApp("yes");
  await sleep(6000);
  const { data: order5 } = await admin
    .from("orders")
    .select("id, status, stripe_checkout_session_id")
    .eq("id", draft5.order?.id ?? "none")
    .maybeSingle();
  const { data: variantAfter5 } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", mugVariant.id)
    .single();
  const case5Pass =
    raceSend.json.reply?.replyAction === "stock_unavailable" &&
    order5?.status === "CANCELLED" &&
    !order5?.stripe_checkout_session_id &&
    variantAfter5?.reserved_quantity === 24;
  record(
    "Case 5: race — stock unavailable at confirm → rejected, not reserved",
    case5Pass,
    `reply=${JSON.stringify(raceSend.json.reply)}\norder=${JSON.stringify(order5)}\nreserved=${variantAfter5?.reserved_quantity}`,
  );

  // ========== Case 6: expiry sweep ==========
  await admin
    .from("product_variants")
    .update({ stock_quantity: 25, reserved_quantity: 0 })
    .eq("id", mugVariant.id);
  await cleanBuyerState(business.id);
  await cleanBuyerOrders(admin, business.id, SWEEP_BUYER);
  await cleanPendingDrafts(admin, business.id, BUYER);
  const draft6 = await createDraft(business.id);
  const confirm6 = await sendWhatsApp("yes");
  await sleep(5000);
  const expiredOrderId = confirm6.json.reply?.orderId ?? draft6.order?.id;
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await admin
    .from("orders")
    .update({ reserved_until: past })
    .eq("id", expiredOrderId);
  await admin
    .from("product_variants")
    .update({ reserved_quantity: 2 })
    .eq("id", mugVariant.id);

  // Sweep via a *different* buyer: same-buyer new draft cancels AWAITING_PAYMENT
  // (create-draft change flow) before confirm can run sweepExpiredReservations.
  await cleanPendingDrafts(admin, business.id, SWEEP_BUYER);
  await sendWhatsApp("I'd like 1 of the blue mug", SWEEP_BUYER);
  await sleep(4000);
  const sweepTrigger = await sendWhatsApp("yes", SWEEP_BUYER);
  await sleep(5000);

  const { data: expiredOrder } = await admin
    .from("orders")
    .select("id, status, reserved_until")
    .eq("id", expiredOrderId)
    .maybeSingle();
  const { data: variantAfter6 } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", mugVariant.id)
    .single();
  const case6Pass =
    expiredOrder?.status === "EXPIRED" &&
    !expiredOrder?.reserved_until &&
    variantAfter6?.reserved_quantity === 1;
  record(
    "Case 6: backdated reserved_until → lazy sweep releases stock, EXPIRED",
    case6Pass,
    `expiredOrder=${JSON.stringify(expiredOrder)}\nreserved=${variantAfter6?.reserved_quantity}\nsweepTrigger=${JSON.stringify(sweepTrigger.json.reply)}`,
  );

  await admin
    .from("product_variants")
    .update({ stock_quantity: 25, reserved_quantity: 0 })
    .eq("id", mugVariant.id);

  console.log("\n========================================");
  console.log("Case 2 (manual): open Checkout URL in browser");
  console.log("  Confirm card + Pay by Bank offered, correct amount/destination");
  console.log("========================================");
  console.log(`Checkout URL from Case 1:\n${checkoutUrlFromTest1 ?? "(none)"}\n`);

  console.log("========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  exitCode = allPassed ? 0 : 1;
  } finally {
    await cleanBuyerState(business.id);
    await cleanBuyerOrders(admin, business.id, SWEEP_BUYER);
    await admin
      .from("product_variants")
      .update({ stock_quantity: 25, reserved_quantity: 0 })
      .eq("id", mugVariant.id);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exit(1);
  });
