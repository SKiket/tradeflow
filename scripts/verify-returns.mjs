/**
 * Verifies buyer return requests (WhatsApp + tracking page) through seller
 * approve/decline, return slip, and refund via the existing Step 13 path.
 *
 *  1. Signed WhatsApp on a DELIVERED order → requestReturn, damaged_faulty
 *  2. Two DELIVERED orders, vague return request → ask which, do not guess
 *  3. Tracking-page POST on a different DELIVERED order → same shared function
 *  4. Delivery WhatsApp includes a neutral tracking link (no return prompt)
 *  5. Seller approve → RETURN_APPROVED + slip WhatsApp; slip HTML has print CSS
 *  6. Mark RETURNED, then refund via POST /api/orders/:id/refund
 *  7. Decline a different order → RETURN_DECLINED + returns policy text
 *  8. Non-DELIVERED rejected on both WhatsApp and tracking-page paths
 *  9. Cross-tenant decide/mark-returned rejected
 *
 * Requires the Next.js dev server:
 *   node scripts/verify-returns.mjs
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const SELLER = process.env.SELLER_PHONE ?? "+447733308706";
const RETURNS_TEXT = "Returns accepted within 14 days, unworn, with tags";

const WA_ONE = "+447700900221";
const WA_MULTI = "+447700900222";
const TRACK = "+447700900223";
const DECLINE = "+447700900224";
const NOT_DELIVERED = "+447700900225";
const REFUND_PHONE = "+447700900226";
const DELIVER_PHONE = "+447700900227";

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
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" });

const results = [];
let whatsappExchange = { inbound: "", outbound: "" };
let deliveryMessageText = "";
let approveMessageText = "";
let declineMessageText = "";
let slipHtml = "";

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(endpoint, params) {
  const sorted = Object.keys(params).sort();
  let data = endpoint;
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

async function sendWhatsApp(fromPhone, bodyText) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${fromPhone}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Returns Tester",
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
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function cleanPhone(businessId, phone) {
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", phone);
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
  await admin.from("customers").delete().in("id", ids);
}

async function ensureCustomer(businessId, phone, name) {
  const { data, error } = await admin
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: phone,
      name,
      channel_identifiers: { whatsapp: phone },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "customer insert failed");
  return data.id;
}

async function createOrder(params) {
  const orderRef = `TF-RET-${randomBytes(3).toString("hex").toUpperCase()}`;
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: params.businessId,
      customer_id: params.customerId,
      channel: "whatsapp",
      status: params.status,
      total_pence: params.unitPrice,
      order_ref: orderRef,
      thread_id: null,
      stripe_payment_intent_id: params.paymentIntentId ?? null,
    })
    .select("id, order_ref")
    .single();
  if (error || !order) throw new Error(error?.message ?? "order insert failed");
  const { error: itemError } = await admin.from("order_items").insert({
    order_id: order.id,
    business_id: params.businessId,
    product_variant_id: params.variantId,
    quantity: 1,
    unit_price_pence: params.unitPrice,
  });
  if (itemError) throw new Error(itemError.message);
  return order;
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
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signStripe(payload),
    },
    body: payload,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function createPaidOrder(business, customerId, variant, unitPrice) {
  const orderRef = `TF-RET-${randomBytes(3).toString("hex").toUpperCase()}`;
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: business.id,
      customer_id: customerId,
      channel: "whatsapp",
      status: "AWAITING_PAYMENT",
      total_pence: unitPrice,
      order_ref: orderRef,
      reserved_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .select("id, order_ref")
    .single();
  if (error || !order) throw new Error(error?.message ?? "paid order create failed");

  await admin.from("order_items").insert({
    order_id: order.id,
    business_id: business.id,
    product_variant_id: variant.id,
    quantity: 1,
    unit_price_pence: unitPrice,
  });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "gbp",
          unit_amount: unitPrice,
          product_data: { name: "Return refund test" },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      transfer_data: { destination: business.stripe_connected_account_id },
      metadata: { order_id: order.id, order_ref: orderRef },
    },
    metadata: { order_id: order.id, order_ref: orderRef },
    success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE}/pay/cancelled`,
  });

  await admin
    .from("orders")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", order.id);

  const pi = await stripe.paymentIntents.create({
    amount: unitPrice,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination: business.stripe_connected_account_id },
    metadata: { order_id: order.id, order_ref: orderRef },
  });

  await admin
    .from("orders")
    .update({ stripe_payment_intent_id: pi.id })
    .eq("id", order.id);

  await postStripeEvent(
    checkoutEvent("checkout.session.completed", {
      id: session.id,
      payment_intent: pi.id,
      payment_status: "paid",
      metadata: { order_id: order.id, order_ref: orderRef },
    }),
  );
  await sleep(1500);

  const { data: paid } = await admin
    .from("orders")
    .select("id, order_ref, status, stripe_payment_intent_id")
    .eq("id", order.id)
    .single();
  if (paid?.status !== "PAID") {
    throw new Error(`Expected PAID after fulfil, got ${paid?.status}`);
  }
  return paid;
}

async function latestSellerReturnMessage(businessId, orderRef) {
  const { data } = await admin
    .from("messages")
    .select("normalised_text, created_at")
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%Return requested for ${orderRef}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.normalised_text ?? "";
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
    .select(
      "id, name, owner_user_id, whatsapp_phone_e164, returns_policy_text, seller_whatsapp_phone_e164, stripe_connected_account_id, stripe_charges_enabled, dispatch_address_line1, dispatch_city, dispatch_postcode",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (business.whatsapp_phone_e164 !== SANDBOX_NUMBER) {
    throw new Error("Sandbox number not mapped to EK-Pousser_D");
  }

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) throw new Error("Owner email not found");

  const { data: products } = await admin
    .from("products")
    .select("id, name, price_pence, product_variants(id, label, deleted_at)")
    .eq("business_id", business.id)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("name", "%blue mug%");
  const mug = products?.[0];
  const mugVariant = (mug?.product_variants ?? []).find((v) => !v.deleted_at);
  if (!mug || !mugVariant) throw new Error("Classic Blue Mug variant not found");

  const previous = {
    returns_policy_text: business.returns_policy_text,
    seller_whatsapp_phone_e164: business.seller_whatsapp_phone_e164,
  };

  await admin
    .from("businesses")
    .update({
      returns_policy_text: RETURNS_TEXT,
      seller_whatsapp_phone_e164: SELLER,
    })
    .eq("id", business.id);

  const ownerToken = await signIn(ownerEmail);
  const phones = [WA_ONE, WA_MULTI, TRACK, DECLINE, NOT_DELIVERED, REFUND_PHONE, DELIVER_PHONE];

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Mug variant: ${mugVariant.id} @ ${mug.price_pence}p\n`);

  try {
    for (const phone of phones) {
      await cleanPhone(business.id, phone);
    }

    const waCustomer = await ensureCustomer(business.id, WA_ONE, "Return WA One");
    const waOrder = await createOrder({
      businessId: business.id,
      customerId: waCustomer,
      status: "DELIVERED",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
    });

    const multiCustomer = await ensureCustomer(business.id, WA_MULTI, "Return WA Multi");
    const multiA = await createOrder({
      businessId: business.id,
      customerId: multiCustomer,
      status: "DELIVERED",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
    });
    const multiB = await createOrder({
      businessId: business.id,
      customerId: multiCustomer,
      status: "DELIVERED",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
    });

    const trackCustomer = await ensureCustomer(business.id, TRACK, "Return Track");
    const trackOrder = await createOrder({
      businessId: business.id,
      customerId: trackCustomer,
      status: "DELIVERED",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
    });

    const declineCustomer = await ensureCustomer(business.id, DECLINE, "Return Decline");
    const declineOrder = await createOrder({
      businessId: business.id,
      customerId: declineCustomer,
      status: "DELIVERED",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
    });

    const paidCustomer = await ensureCustomer(business.id, NOT_DELIVERED, "Return Paid");
    const paidOrder = await createOrder({
      businessId: business.id,
      customerId: paidCustomer,
      status: "PAID",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
    });

    const deliverCustomer = await ensureCustomer(business.id, DELIVER_PHONE, "Return Deliver Msg");
    const deliverOrder = await createOrder({
      businessId: business.id,
      customerId: deliverCustomer,
      status: "DISPATCHED",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
    });

    // ========== 1. WhatsApp return on DELIVERED ==========
    const inbound1 = "this arrived damaged, can I return it?";
    const c1 = await sendWhatsApp(WA_ONE, inbound1);
    await sleep(500);
    const { data: after1 } = await admin
      .from("orders")
      .select("id, status, return_reason, return_reason_detail, return_requested_at")
      .eq("id", waOrder.id)
      .single();
    const seller1 = await latestSellerReturnMessage(business.id, waOrder.order_ref);
    const reply1 = c1.json.support?.reply ?? "";
    whatsappExchange = { inbound: inbound1, outbound: reply1 };

    const case1Pass =
      c1.status === 200 &&
      c1.json.support?.returnOutcome?.action === "requested" &&
      after1?.status === "RETURN_REQUESTED" &&
      after1?.return_reason === "damaged_faulty" &&
      Boolean(after1?.return_requested_at) &&
      reply1.includes(waOrder.order_ref) &&
      /damaged/i.test(reply1) &&
      seller1.includes(waOrder.order_ref);
    record(
      "1. WhatsApp DELIVERED return → shared requestReturn, damaged_faulty, seller notified",
      case1Pass,
      `inbound="${inbound1}"\noutbound="${reply1}"\nstatus=${after1?.status} reason=${after1?.return_reason}\nseller="${seller1}"\noutcome=${JSON.stringify(c1.json.support?.returnOutcome)}`,
    );

    // ========== 2. Multi-order ambiguity ==========
    const inbound2 = "can I return this?";
    const c2 = await sendWhatsApp(WA_MULTI, inbound2);
    const { data: afterMulti } = await admin
      .from("orders")
      .select("id, status")
      .in("id", [multiA.id, multiB.id]);
    const stillDelivered = (afterMulti ?? []).every((row) => row.status === "DELIVERED");
    const reply2 = c2.json.support?.reply ?? "";
    const asksWhich =
      c2.json.support?.returnOutcome?.action === "needs_clarification" &&
      reply2.includes(multiA.order_ref) &&
      reply2.includes(multiB.order_ref);
    record(
      "2. Vague return with two DELIVERED orders → asks which, does not guess",
      c2.status === 200 && stillDelivered && asksWhich,
      `outbound="${reply2}"\noutcome=${JSON.stringify(c2.json.support?.returnOutcome)}\nstatuses=${JSON.stringify(afterMulti)}`,
    );

    // ========== 3. Tracking page path ==========
    const trackPost = await fetch(`${BASE}/api/t/${encodeURIComponent(trackOrder.order_ref)}/return`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "changed_mind",
        detail: "changed my mind after trying it",
      }),
    });
    const trackJson = await trackPost.json().catch(() => ({}));
    const { data: afterTrack } = await admin
      .from("orders")
      .select("status, return_reason, return_reason_detail")
      .eq("id", trackOrder.id)
      .single();
    const sellerTrack = await latestSellerReturnMessage(business.id, trackOrder.order_ref);
    record(
      "3. Tracking-page return on a different order → same requestReturn()",
      trackPost.status === 200 &&
        trackJson.action === "requested" &&
        afterTrack?.status === "RETURN_REQUESTED" &&
        afterTrack?.return_reason === "changed_mind" &&
        sellerTrack.includes(trackOrder.order_ref),
      `http=${trackPost.status} body=${JSON.stringify(trackJson)}\nstatus=${afterTrack?.status} reason=${afterTrack?.return_reason}\nseller="${sellerTrack}"`,
    );

    // ========== 4. Delivery message tracking link ==========
    const deliverRes = await apiPost(ownerToken, `/api/orders/${deliverOrder.id}/deliver`);
    await sleep(800);
    const { data: deliverMsg } = await admin
      .from("messages")
      .select("normalised_text")
      .eq("customer_id", deliverCustomer)
      .eq("direction", "outbound")
      .ilike("normalised_text", `%${deliverOrder.order_ref}%delivered%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    deliveryMessageText = deliverMsg?.normalised_text ?? "";
    const hasNeutralLink = /Track or manage your order:\s*https?:\/\/\S+\/t\//i.test(
      deliveryMessageText,
    );
    const promptsReturn = /return this|want to return|request a return/i.test(
      deliveryMessageText,
    );
    record(
      "4. Delivery WhatsApp includes neutral tracking link, no return-prompting language",
      deliverRes.status === 200 && hasNeutralLink && !promptsReturn,
      `api=${deliverRes.status} ${JSON.stringify(deliverRes.json)}\nmsg="${deliveryMessageText}"`,
    );

    // ========== 5. Approve WhatsApp order + return slip ==========
    const approveRes = await apiPost(
      ownerToken,
      `/api/orders/${waOrder.id}/return-decision`,
      { decision: "approve" },
    );
    await sleep(800);
    const { data: approved } = await admin
      .from("orders")
      .select("status")
      .eq("id", waOrder.id)
      .single();
    const { data: approveMsg } = await admin
      .from("messages")
      .select("normalised_text")
      .eq("customer_id", waCustomer)
      .eq("direction", "outbound")
      .ilike("normalised_text", `%${waOrder.order_ref}%approved%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    approveMessageText = approveMsg?.normalised_text ?? "";
    const slipUrlMatch = approveMessageText.match(/https?:\/\/\S+\/return-slip/);
    const postageNote = /return postage/i.test(approveMessageText);
    const slipPath = `/t/${encodeURIComponent(waOrder.order_ref)}/return-slip`;
    const slipRes = await fetch(`${BASE}${slipPath}`);
    slipHtml = await slipRes.text();
    const slipOk =
      slipRes.status === 200 &&
      slipHtml.includes(waOrder.order_ref) &&
      slipHtml.includes(business.name) &&
      /@media print/.test(slipHtml) &&
      (business.dispatch_address_line1
        ? slipHtml.includes(business.dispatch_address_line1)
        : true);
    record(
      "5. Approve → RETURN_APPROVED, buyer WhatsApp with working return-slip + print CSS",
      approveRes.status === 200 &&
        approved?.status === "RETURN_APPROVED" &&
        Boolean(slipUrlMatch) &&
        postageNote &&
        slipOk,
      `api=${approveRes.status} status=${approved?.status}\nmsg="${approveMessageText}"\nslipHttp=${slipRes.status} printCss=${/@media print/.test(slipHtml)}`,
    );

    // ========== 6. Mark returned + existing refund API ==========
    const refundCustomer = await ensureCustomer(business.id, REFUND_PHONE, "Return Refund");
    const paid = await createPaidOrder(
      business,
      refundCustomer,
      mugVariant,
      mug.price_pence,
    );
    await admin.from("orders").update({ status: "DELIVERED" }).eq("id", paid.id);
    const refundReturn = await fetch(`${BASE}/api/t/${encodeURIComponent(paid.order_ref)}/return`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "wrong_size" }),
    });
    const refundReturnJson = await refundReturn.json().catch(() => ({}));
    const approvePaid = await apiPost(
      ownerToken,
      `/api/orders/${paid.id}/return-decision`,
      { decision: "approve" },
    );
    const marked = await apiPost(ownerToken, `/api/orders/${paid.id}/mark-returned`);
    const { data: returnedRow } = await admin
      .from("orders")
      .select("status, return_reason, stripe_payment_intent_id")
      .eq("id", paid.id)
      .single();
    const refundRes = await apiPost(ownerToken, `/api/orders/${paid.id}/refund`, {
      amountPence: mug.price_pence,
      reason: "returned item",
    });
    const { data: afterRefund } = await admin
      .from("orders")
      .select("status")
      .eq("id", paid.id)
      .single();
    record(
      "6. RETURNED → existing Step 13 refund API (no second refund mechanism)",
      refundReturn.status === 200 &&
        refundReturnJson.action === "requested" &&
        approvePaid.status === 200 &&
        marked.status === 200 &&
        returnedRow?.status === "RETURNED" &&
        returnedRow?.return_reason === "wrong_size" &&
        refundRes.status === 200 &&
        refundRes.json.action === "refund_pending" &&
        afterRefund?.status === "REFUND_PENDING",
      `return=${refundReturn.status} approve=${approvePaid.status} marked=${marked.status} returned=${returnedRow?.status}\nrefund=${refundRes.status} ${JSON.stringify(refundRes.json)}\nfinal=${afterRefund?.status}`,
    );

    // ========== 7. Decline ==========
    const declineReq = await fetch(
      `${BASE}/api/t/${encodeURIComponent(declineOrder.order_ref)}/return`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "not_as_described", detail: "colour was off" }),
      },
    );
    const declineDec = await apiPost(
      ownerToken,
      `/api/orders/${declineOrder.id}/return-decision`,
      { decision: "decline" },
    );
    await sleep(800);
    const { data: declined } = await admin
      .from("orders")
      .select("status")
      .eq("id", declineOrder.id)
      .single();
    const { data: declineMsg } = await admin
      .from("messages")
      .select("normalised_text")
      .eq("customer_id", declineCustomer)
      .eq("direction", "outbound")
      .ilike("normalised_text", `%${declineOrder.order_ref}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    declineMessageText = declineMsg?.normalised_text ?? "";
    record(
      "7. Decline → RETURN_DECLINED, buyer notified with real returns policy text",
      declineReq.status === 200 &&
        declineDec.status === 200 &&
        declined?.status === "RETURN_DECLINED" &&
        declineMessageText.includes(RETURNS_TEXT) &&
        /wasn't approved|was not approved|wasn't approved/i.test(declineMessageText),
      `status=${declined?.status}\nmsg="${declineMessageText}"`,
    );

    // ========== 8. Non-DELIVERED both paths ==========
    const waPaid = await sendWhatsApp(NOT_DELIVERED, "I'd like to return this please");
    const { data: stillPaid } = await admin
      .from("orders")
      .select("status")
      .eq("id", paidOrder.id)
      .single();
    const replyPaid = waPaid.json.support?.reply ?? "";
    const trackPaid = await fetch(
      `${BASE}/api/t/${encodeURIComponent(paidOrder.order_ref)}/return`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "changed_mind" }),
      },
    );
    const trackPaidJson = await trackPaid.json().catch(() => ({}));
    record(
      "8. Return rejected on non-DELIVERED via WhatsApp and tracking page",
      stillPaid?.status === "PAID" &&
        (waPaid.json.support?.returnOutcome?.action === "not_delivered" ||
          /delivered/i.test(replyPaid)) &&
        trackPaid.status === 400 &&
        trackPaidJson.action === "not_delivered",
      `waReply="${replyPaid}"\nwaOutcome=${JSON.stringify(waPaid.json.support?.returnOutcome)}\ntrack=${trackPaid.status} ${JSON.stringify(trackPaidJson)}`,
    );

    // ========== 9. Cross-tenant ==========
    const OTHER_EMAIL = `other-return-${Date.now()}@tradeflow-test.local`;
    await cleanupOtherUser(OTHER_EMAIL);
    const { data: otherUser } = await admin.auth.admin.createUser({
      email: OTHER_EMAIL,
      email_confirm: true,
    });
    await admin.from("businesses").insert({
      owner_user_id: otherUser.user.id,
      name: "Other Return Shop",
      slug: `other-ret-${Date.now()}`,
      dispatch_address_line1: "2 Other St",
      dispatch_city: "London",
      dispatch_postcode: "E2 2BB",
      payout_account_holder_name: "Other",
      payout_sort_code: "11-22-33",
      payout_account_number: "87654321",
    });
    const otherToken = await signIn(OTHER_EMAIL);
    const crossApprove = await apiPost(
      otherToken,
      `/api/orders/${trackOrder.id}/return-decision`,
      { decision: "approve" },
    );
    const crossReturned = await apiPost(
      otherToken,
      `/api/orders/${paid.id}/mark-returned`,
    );
    const { data: trackStill } = await admin
      .from("orders")
      .select("status")
      .eq("id", trackOrder.id)
      .single();
    record(
      "9. Other tenant cannot approve or mark-returned (404)",
      crossApprove.status === 404 &&
        crossReturned.status === 404 &&
        trackStill?.status === "RETURN_REQUESTED",
      `approve=${crossApprove.status} mark=${crossReturned.status} trackStatus=${trackStill?.status}`,
    );
    await cleanupOtherUser(OTHER_EMAIL);
  } finally {
    await admin
      .from("businesses")
      .update({
        returns_policy_text: previous.returns_policy_text,
        seller_whatsapp_phone_e164: previous.seller_whatsapp_phone_e164,
      })
      .eq("id", business.id);
    for (const phone of phones) {
      await cleanPhone(business.id, phone);
    }
  }

  console.log("\n--- Exact WhatsApp exchange (test 1) ---");
  console.log(`Buyer: ${whatsappExchange.inbound}`);
  console.log(`TradeFlow: ${whatsappExchange.outbound}`);
  console.log("\n--- Exact delivery message (test 4) ---");
  console.log(deliveryMessageText);

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.filter((r) => r.passed).length}/${results.length} passed`);
  if (failed.length) {
    console.error("Failed:", failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
