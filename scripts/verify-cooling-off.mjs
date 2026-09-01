/**
 * Verifies statutory cooling-off auto-approval for changed_mind returns
 * within businesses.return_window_days. Other reasons / outside-window
 * still go through seller Approve/Decline.
 *
 *  1. changed_mind, delivered 5 days ago, window 14 → RETURN_APPROVED
 *  2. changed_mind, delivered 20 days ago → RETURN_REQUESTED
 *  3. damaged_faulty, delivered yesterday → RETURN_REQUESTED
 *  4. Settings return_window_days=7 shows warning, save is not blocked
 *  5. Dashboard HTML distinguishes auto-approved vs seller-approved
 *  6. Tracking-page path uses the same auto-approval
 *  7. Mark Returned → existing Step 13 refund after auto-approval
 *  8. return_window_days is per-business
 *
 * Requires the Next.js dev server:
 *   node scripts/verify-cooling-off.mjs
 */
import { createHmac, randomBytes } from "node:crypto";
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
const SELLER = process.env.SELLER_PHONE ?? "+447733308706";
const EK_EMAIL = "sgkiket@gmail.com";
const WARNING =
  "UK law requires a minimum 14-day cooling-off period for most online orders — check with a solicitor before setting this lower.";

const WA_IN = "+447700900241";
const WA_OUT = "+447700900242";
const WA_FAULT = "+447700900243";
const TRACK = "+447700900244";
const REFUND_PHONE = "+447700900245";
const SELLER_APP = "+447700900246";

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
let buyerAutoText = "";
let sellerAutoText = "";

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
    ProfileName: "Cooling-off Tester",
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

async function mintCookies(email) {
  const cookies = [];
  const supabase = createBrowserClient(url, anonKey, {
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
  return { supabase, cookies };
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
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

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function createDeliveredOrder(params) {
  const orderRef = `TF-CO-${randomBytes(3).toString("hex").toUpperCase()}`;
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: params.businessId,
      customer_id: params.customerId,
      channel: "whatsapp",
      status: "DELIVERED",
      total_pence: params.unitPrice,
      order_ref: orderRef,
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
  const { error: histError } = await admin.from("order_status_history").insert({
    order_id: order.id,
    business_id: params.businessId,
    from_status: "DISPATCHED",
    to_status: "DELIVERED",
    changed_at: params.deliveredAt,
  });
  if (histError) throw new Error(histError.message);
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

async function createPaidThenDelivered(business, customerId, variant, unitPrice, deliveredAt) {
  const orderRef = `TF-CO-${randomBytes(3).toString("hex").toUpperCase()}`;
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
          product_data: { name: "Cooling-off refund test" },
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

  await admin.from("orders").update({ status: "DELIVERED" }).eq("id", order.id);
  await admin.from("order_status_history").insert({
    order_id: order.id,
    business_id: business.id,
    from_status: "PAID",
    to_status: "DELIVERED",
    changed_at: deliveredAt,
  });

  return { id: order.id, order_ref: orderRef, stripe_payment_intent_id: pi.id };
}

async function latestOutbound(customerId, pattern) {
  const { data } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("customer_id", customerId)
    .eq("direction", "outbound")
    .ilike("normalised_text", pattern)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.normalised_text ?? "";
}

async function latestSellerText(businessId, pattern) {
  const { data } = await admin
    .from("messages")
    .select("normalised_text")
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .ilike("normalised_text", pattern)
    .order("created_at", { ascending: false })
    .limit(5);
  return (data ?? []).map((row) => row.normalised_text).find(Boolean) ?? "";
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
      "id, name, owner_user_id, whatsapp_phone_e164, return_window_days, seller_whatsapp_phone_e164, stripe_connected_account_id",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (business.whatsapp_phone_e164 !== SANDBOX_NUMBER) {
    throw new Error("Sandbox number not mapped to EK-Pousser_D");
  }

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email ?? EK_EMAIL;

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
    return_window_days: business.return_window_days,
    seller_whatsapp_phone_e164: business.seller_whatsapp_phone_e164,
  };

  await admin
    .from("businesses")
    .update({
      return_window_days: 14,
      seller_whatsapp_phone_e164: SELLER,
    })
    .eq("id", business.id);

  const phones = [WA_IN, WA_OUT, WA_FAULT, TRACK, REFUND_PHONE, SELLER_APP];
  const ownerToken = await signIn(ownerEmail);
  const { supabase: sellerClient, cookies } = await mintCookies(ownerEmail);

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Window set to 14 days\n`);

  try {
    for (const phone of phones) await cleanPhone(business.id, phone);

    const inCustomer = await ensureCustomer(business.id, WA_IN, "CO in window");
    const inOrder = await createDeliveredOrder({
      businessId: business.id,
      customerId: inCustomer,
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
      deliveredAt: daysAgo(5),
    });

    const outCustomer = await ensureCustomer(business.id, WA_OUT, "CO outside window");
    const outOrder = await createDeliveredOrder({
      businessId: business.id,
      customerId: outCustomer,
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
      deliveredAt: daysAgo(20),
    });

    const faultCustomer = await ensureCustomer(business.id, WA_FAULT, "CO faulty");
    const faultOrder = await createDeliveredOrder({
      businessId: business.id,
      customerId: faultCustomer,
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
      deliveredAt: daysAgo(1),
    });

    const trackCustomer = await ensureCustomer(business.id, TRACK, "CO track");
    const trackOrder = await createDeliveredOrder({
      businessId: business.id,
      customerId: trackCustomer,
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
      deliveredAt: daysAgo(5),
    });

    const sellerAppCustomer = await ensureCustomer(business.id, SELLER_APP, "CO seller app");
    const sellerAppOrder = await createDeliveredOrder({
      businessId: business.id,
      customerId: sellerAppCustomer,
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
      deliveredAt: daysAgo(5),
    });

    // ========== 1. In-window changed_mind WhatsApp ==========
    const inbound1 = "I've changed my mind, can I return it?";
    const c1 = await sendWhatsApp(WA_IN, inbound1);
    const { data: after1 } = await admin
      .from("orders")
      .select("status, return_reason, return_auto_approved")
      .eq("id", inOrder.id)
      .single();
    const { data: hist1 } = await admin
      .from("order_status_history")
      .select("from_status, to_status")
      .eq("order_id", inOrder.id)
      .order("changed_at", { ascending: true });
    const skippedRequested = !(hist1 ?? []).some((h) => h.to_status === "RETURN_REQUESTED");
    buyerAutoText = await latestOutbound(inCustomer, `%${inOrder.order_ref}%approved%`);
    sellerAutoText = await latestSellerText(
      business.id,
      `%no action needed from you. Order ${inOrder.order_ref}%`,
    );
    const buyerHasSlip = /return-slip/.test(buyerAutoText) && /return postage/i.test(buyerAutoText);
    const sellerIsAuto =
      sellerAutoText.includes("automatically approved") &&
      sellerAutoText.includes("no action needed") &&
      sellerAutoText.includes(inOrder.order_ref) &&
      !/approve or decline/i.test(sellerAutoText);

    record(
      "1. changed_mind within 14 days → RETURN_APPROVED, no seller action, both notified",
      c1.status === 200 &&
        c1.json.support?.returnOutcome?.action === "auto_approved" &&
        after1?.status === "RETURN_APPROVED" &&
        after1?.return_reason === "changed_mind" &&
        after1?.return_auto_approved === true &&
        skippedRequested &&
        buyerHasSlip &&
        sellerIsAuto,
      `status=${after1?.status} auto=${after1?.return_auto_approved} skippedRequested=${skippedRequested}\nbuyer="${buyerAutoText}"\nseller="${sellerAutoText}"\noutcome=${JSON.stringify(c1.json.support?.returnOutcome)}`,
    );

    // ========== 2. Outside window changed_mind ==========
    const c2 = await sendWhatsApp(WA_OUT, "I've changed my mind, can I return it?");
    const { data: after2 } = await admin
      .from("orders")
      .select("status, return_auto_approved, return_reason")
      .eq("id", outOrder.id)
      .single();
    record(
      "2. changed_mind 20 days after delivery → RETURN_REQUESTED (seller discretion)",
      c2.status === 200 &&
        c2.json.support?.returnOutcome?.action === "requested" &&
        after2?.status === "RETURN_REQUESTED" &&
        after2?.return_reason === "changed_mind" &&
        after2?.return_auto_approved === false,
      `status=${after2?.status} auto=${after2?.return_auto_approved} outcome=${JSON.stringify(c2.json.support?.returnOutcome)}`,
    );

    // ========== 3. damaged_faulty yesterday ==========
    const c3 = await sendWhatsApp(WA_FAULT, "this arrived damaged, can I return it?");
    const { data: after3 } = await admin
      .from("orders")
      .select("status, return_auto_approved, return_reason")
      .eq("id", faultOrder.id)
      .single();
    record(
      "3. damaged_faulty within window → RETURN_REQUESTED (not auto-approved)",
      c3.status === 200 &&
        c3.json.support?.returnOutcome?.action === "requested" &&
        after3?.status === "RETURN_REQUESTED" &&
        after3?.return_reason === "damaged_faulty" &&
        after3?.return_auto_approved === false,
      `status=${after3?.status} reason=${after3?.return_reason} auto=${after3?.return_auto_approved}`,
    );

    // ========== 4. Settings warning, value 7 saves ==========
    const { error: save7Error } = await sellerClient
      .from("businesses")
      .update({ return_window_days: 7 })
      .eq("id", business.id);
    const { data: saved7 } = await admin
      .from("businesses")
      .select("return_window_days")
      .eq("id", business.id)
      .single();
    const settingsRes = await fetch(`${BASE}/dashboard/settings`, {
      headers: { Cookie: cookieHeader(cookies) },
      redirect: "manual",
    });
    const settingsHtml = await settingsRes.text();
    const warningShown = settingsHtml.includes(WARNING);
    await sellerClient
      .from("businesses")
      .update({ return_window_days: 14 })
      .eq("id", business.id);
    record(
      "4. return_window_days=7 shows warning and is not blocked from saving",
      !save7Error && saved7?.return_window_days === 7 && warningShown,
      `saveError=${save7Error?.message ?? "none"} saved=${saved7?.return_window_days} htmlStatus=${settingsRes.status} warning=${warningShown}`,
    );

    // ========== 5. Dashboard distinguishes auto vs seller-approved ==========
    const sellerReq = await fetch(
      `${BASE}/api/t/${encodeURIComponent(sellerAppOrder.order_ref)}/return`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "wrong_size" }),
      },
    );
    const sellerApprove = await apiPost(
      ownerToken,
      `/api/orders/${sellerAppOrder.id}/return-decision`,
      { decision: "approve" },
    );
    const autoPage = await fetch(`${BASE}/dashboard/orders/${inOrder.id}`, {
      headers: { Cookie: cookieHeader(cookies) },
      redirect: "manual",
    });
    const sellerPage = await fetch(`${BASE}/dashboard/orders/${sellerAppOrder.id}`, {
      headers: { Cookie: cookieHeader(cookies) },
      redirect: "manual",
    });
    const autoHtml = await autoPage.text();
    const sellerHtml = await sellerPage.text();
    const autoLabel = "Auto-approved — statutory cooling-off right";
    record(
      "5. Dashboard distinguishes auto-approved from seller-approved",
      sellerReq.status === 200 &&
        sellerApprove.status === 200 &&
        autoPage.status === 200 &&
        sellerPage.status === 200 &&
        autoHtml.includes(autoLabel) &&
        !sellerHtml.includes(autoLabel),
      `autoHttp=${autoPage.status} sellerHttp=${sellerPage.status} autoHasLabel=${autoHtml.includes(autoLabel)} sellerHasLabel=${sellerHtml.includes(autoLabel)}`,
    );

    // ========== 6. Tracking-page auto-approval ==========
    const trackPost = await fetch(
      `${BASE}/api/t/${encodeURIComponent(trackOrder.order_ref)}/return`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "changed_mind" }),
      },
    );
    const trackJson = await trackPost.json().catch(() => ({}));
    const { data: afterTrack } = await admin
      .from("orders")
      .select("status, return_reason, return_auto_approved")
      .eq("id", trackOrder.id)
      .single();
    const trackBuyer = await latestOutbound(trackCustomer, `%${trackOrder.order_ref}%approved%`);
    const trackSeller = await latestSellerText(
      business.id,
      `%no action needed from you. Order ${trackOrder.order_ref}%`,
    );
    record(
      "6. Tracking-page changed_mind within window → same auto-approval",
      trackPost.status === 200 &&
        trackJson.action === "auto_approved" &&
        afterTrack?.status === "RETURN_APPROVED" &&
        afterTrack?.return_auto_approved === true &&
        /return-slip/.test(trackBuyer) &&
        trackSeller.includes("automatically approved"),
      `http=${trackPost.status} action=${trackJson.action} status=${afterTrack?.status}\nbuyer="${trackBuyer}"\nseller="${trackSeller}"`,
    );

    // ========== 7. Refund after auto-approval ==========
    const refundCustomer = await ensureCustomer(business.id, REFUND_PHONE, "CO refund");
    const paid = await createPaidThenDelivered(
      business,
      refundCustomer,
      mugVariant,
      mug.price_pence,
      daysAgo(3),
    );
    const refundReturn = await fetch(
      `${BASE}/api/t/${encodeURIComponent(paid.order_ref)}/return`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "changed_mind" }),
      },
    );
    const refundReturnJson = await refundReturn.json().catch(() => ({}));
    const marked = await apiPost(ownerToken, `/api/orders/${paid.id}/mark-returned`);
    const refundRes = await apiPost(ownerToken, `/api/orders/${paid.id}/refund`, {
      amountPence: mug.price_pence,
      reason: "cooling-off return",
    });
    record(
      "7. Auto-approved → Mark Returned → existing Step 13 refund",
      refundReturn.status === 200 &&
        refundReturnJson.action === "auto_approved" &&
        marked.status === 200 &&
        refundRes.status === 200 &&
        refundRes.json.action === "refund_pending" &&
        refundRes.json.priorStatus === "RETURNED",
      `return=${refundReturnJson.action} marked=${marked.status} refund=${refundRes.status} ${JSON.stringify(refundRes.json)}`,
    );

    // ========== 8. Per-business window ==========
    const OTHER_EMAIL = `other-co-${Date.now()}@tradeflow-test.local`;
    await cleanupOtherUser(OTHER_EMAIL);
    const { data: otherUser } = await admin.auth.admin.createUser({
      email: OTHER_EMAIL,
      email_confirm: true,
    });
    const { data: otherBiz, error: otherBizErr } = await admin
      .from("businesses")
      .insert({
        owner_user_id: otherUser.user.id,
        name: "Other Cooling Shop",
        slug: `other-co-${Date.now()}`,
        dispatch_address_line1: "2 Other St",
        dispatch_city: "London",
        dispatch_postcode: "E2 2BB",
        payout_account_holder_name: "Other",
        payout_sort_code: "11-22-33",
        payout_account_number: "87654321",
        return_window_days: 1,
      })
      .select("id")
      .single();
    if (otherBizErr || !otherBiz) throw new Error(otherBizErr?.message ?? "other biz failed");

    const { data: otherCustomer } = await admin
      .from("customers")
      .insert({
        business_id: otherBiz.id,
        phone_e164: "+447700900299",
        name: "Other CO buyer",
        channel_identifiers: { whatsapp: "+447700900299" },
      })
      .select("id")
      .single();
    const otherOrder = await createDeliveredOrder({
      businessId: otherBiz.id,
      customerId: otherCustomer.id,
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
      deliveredAt: daysAgo(5),
    });
    const otherPost = await fetch(
      `${BASE}/api/t/${encodeURIComponent(otherOrder.order_ref)}/return`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "changed_mind" }),
      },
    );
    const otherJson = await otherPost.json().catch(() => ({}));
    const { data: otherAfter } = await admin
      .from("orders")
      .select("status, return_auto_approved, business_id")
      .eq("id", otherOrder.id)
      .single();
    const { data: ekWindow } = await admin
      .from("businesses")
      .select("return_window_days")
      .eq("id", business.id)
      .single();
    const { data: otherWindow } = await admin
      .from("businesses")
      .select("return_window_days")
      .eq("id", otherBiz.id)
      .single();

    record(
      "8. return_window_days is per-business (1-day tenant does not auto-approve 5-day-old)",
      otherPost.status === 200 &&
        otherJson.action === "requested" &&
        otherAfter?.status === "RETURN_REQUESTED" &&
        otherAfter?.return_auto_approved === false &&
        ekWindow?.return_window_days === 14 &&
        otherWindow?.return_window_days === 1,
      `otherAction=${otherJson.action} otherStatus=${otherAfter?.status} ekWindow=${ekWindow?.return_window_days} otherWindow=${otherWindow?.return_window_days}`,
    );

    await admin.from("order_items").delete().eq("order_id", otherOrder.id);
    await admin.from("order_status_history").delete().eq("order_id", otherOrder.id);
    await admin.from("orders").delete().eq("id", otherOrder.id);
    await admin.from("customers").delete().eq("id", otherCustomer.id);
    await cleanupOtherUser(OTHER_EMAIL);
  } finally {
    await admin
      .from("businesses")
      .update({
        return_window_days: previous.return_window_days ?? 14,
        seller_whatsapp_phone_e164: previous.seller_whatsapp_phone_e164,
      })
      .eq("id", business.id);
    for (const phone of phones) await cleanPhone(business.id, phone);
  }

  console.log("\n--- Auto-approval buyer WhatsApp (test 1) ---");
  console.log(buyerAutoText);
  console.log("\n--- Auto-approval seller WhatsApp (test 1) ---");
  console.log(sellerAutoText);

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
