/**
 * Verification-only: paste exact buyer WhatsApp texts for FR preferred_language
 * lifecycle messages, plus DE support/catalog and full FR returns-policy reply.
 *
 *   node scripts/verify-i18n-lifecycle-texts.mjs
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX = "+14155238886";
const FR_PHONE = "+447700900301";
const DE_PHONE = "+447700900302";
const POLICY =
  "Returns accepted within 14 days of delivery. Buyer pays return postage.";

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
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
const CRON_SECRET = env.CRON_SHARED_SECRET;
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" });

const texts = {};

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

let sid = Date.now();
function nextSid() {
  sid += 1;
  return `SM${sid.toString(16)}${Math.random().toString(16).slice(2, 8)}`;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function sendWa(fromPhone, bodyText) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${fromPhone}`,
    To: `whatsapp:${SANDBOX}`,
    ProfileName: "I18n Lifecycle",
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
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function postStripe(payload) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signStripe(payload),
    },
    body: payload,
    redirect: "manual",
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

function checkoutEvent(type, session) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    data: { object: { object: "checkout.session", ...session } },
  });
}

function refundUpdatedEvent(refund) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type: "refund.updated",
    data: { object: refund },
  });
}

async function signIn(email) {
  const { data: linkData, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${BASE}/auth/callback` },
  });
  if (error) throw error;
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
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function ensureCustomer(businessId, phone, lang) {
  const { data: existing } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", phone)
    .maybeSingle();
  if (existing) {
    await admin
      .from("customers")
      .update({ preferred_language: lang, ai_paused_until: null })
      .eq("id", existing.id);
    return existing.id;
  }
  const { data: created, error } = await admin
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: phone,
      preferred_language: lang,
      channel_identifiers: { whatsapp: phone },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return created.id;
}

async function cleanCustomer(businessId, customerId) {
  const { data: orders } = await admin
    .from("orders")
    .select("id")
    .eq("business_id", businessId)
    .eq("customer_id", customerId);
  const ids = (orders ?? []).map((o) => o.id);
  if (ids.length) {
    await admin.from("order_items").delete().in("order_id", ids);
    await admin.from("order_status_history").delete().in("order_id", ids);
    await admin.from("orders").delete().in("id", ids);
  }
  await admin.from("messages").delete().eq("customer_id", customerId);
}

async function latestOutbound(customerId, contains) {
  let q = admin
    .from("messages")
    .select("normalised_text, created_at")
    .eq("customer_id", customerId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(20);
  const { data } = await q;
  const rows = data ?? [];
  if (!contains) return rows[0]?.normalised_text ?? null;
  const hit = rows.find((r) => (r.normalised_text ?? "").includes(contains));
  return hit?.normalised_text ?? null;
}

async function getVariant(businessId) {
  const { data: products } = await admin
    .from("products")
    .select("id, name, price_pence, product_variants(id, deleted_at, stock_quantity, reserved_quantity, track_inventory, label)")
    .eq("business_id", businessId)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("name", "%blue mug%")
    .limit(1);
  const product = products?.[0];
  const variant = (product?.product_variants ?? []).find((v) => !v.deleted_at);
  if (!product || !variant) throw new Error("Classic Blue Mug variant missing");
  await admin
    .from("product_variants")
    .update({ stock_quantity: 50, reserved_quantity: 0, track_inventory: true })
    .eq("id", variant.id);
  return { product, variant };
}

async function createOrder(params) {
  const ref = `TF-I18N-${randomBytes(3).toString("hex").toUpperCase()}`;
  const threadId = params.threadId ?? randomUUID();
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: params.businessId,
      customer_id: params.customerId,
      thread_id: threadId,
      channel: "whatsapp",
      status: params.status,
      total_pence: params.totalPence,
      order_ref: ref,
      reserved_until: params.reservedUntil ?? null,
      shipping_address: params.shippingAddress ?? null,
      stripe_checkout_session_id: params.checkoutSessionId ?? null,
      stripe_payment_intent_id: params.paymentIntentId ?? null,
    })
    .select("id, order_ref, thread_id")
    .single();
  if (error) throw new Error(error.message);
  await admin.from("order_items").insert({
    order_id: order.id,
    business_id: params.businessId,
    product_variant_id: params.variantId,
    quantity: params.qty ?? 1,
    unit_price_pence: params.unitPrice,
  });
  if (params.historyTo) {
    await admin.from("order_status_history").insert({
      order_id: order.id,
      business_id: params.businessId,
      from_status: params.historyFrom ?? null,
      to_status: params.historyTo,
      changed_at: params.historyAt ?? new Date().toISOString(),
    });
  }
  return order;
}

const BAKER = {
  line1: "221B Baker Street",
  line2: "Flat 2",
  city: "London",
  postcode: "NW1 6XE",
  country: "GB",
};

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select(
      "id, name, owner_user_id, stripe_connected_account_id, stripe_charges_enabled, returns_policy_text, whatsapp_phone_e164",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (business.whatsapp_phone_e164 !== SANDBOX) {
    throw new Error("Sandbox not mapped to EK-Pousser_D");
  }

  const priorPolicy = business.returns_policy_text;
  await admin
    .from("businesses")
    .update({ returns_policy_text: POLICY })
    .eq("id", business.id);

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerToken = await signIn(owner.user.email);

  const { product, variant } = await getVariant(business.id);
  const unitPrice = product.price_pence;

  const frId = await ensureCustomer(business.id, FR_PHONE, "fr");
  await cleanCustomer(business.id, frId);
  await admin
    .from("customers")
    .update({ preferred_language: "fr" })
    .eq("id", frId);

  console.log("=== FR customer", frId, FR_PHONE, "preferred_language=fr ===\n");

  // ----- payment received -----
  {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: unitPrice,
            product_data: { name: product.name },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        transfer_data: { destination: business.stripe_connected_account_id },
      },
      success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE}/pay/cancelled`,
    });
    const order = await createOrder({
      businessId: business.id,
      customerId: frId,
      status: "AWAITING_PAYMENT",
      totalPence: unitPrice,
      variantId: variant.id,
      unitPrice,
      checkoutSessionId: session.id,
      historyTo: "AWAITING_PAYMENT",
      historyFrom: "PENDING_CONFIRMATION",
    });
    await postStripe(
      checkoutEvent("checkout.session.completed", {
        id: session.id,
        payment_status: "paid",
        metadata: { order_id: order.id, order_ref: order.order_ref },
      }),
    );
    await sleep(1500);
    texts.payment_received = await latestOutbound(frId, order.order_ref);
    console.log("--- payment received ---");
    console.log(texts.payment_received);
  }

  // ----- payment failed -----
  {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "pay_by_bank"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: unitPrice,
            product_data: { name: product.name },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        transfer_data: { destination: business.stripe_connected_account_id },
      },
      success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE}/pay/cancelled`,
    });
    const order = await createOrder({
      businessId: business.id,
      customerId: frId,
      status: "AWAITING_PAYMENT",
      totalPence: unitPrice,
      variantId: variant.id,
      unitPrice,
      checkoutSessionId: session.id,
      reservedUntil: new Date(Date.now() + 3600_000).toISOString(),
      historyTo: "AWAITING_PAYMENT",
      historyFrom: "PENDING_CONFIRMATION",
    });
    await admin
      .from("product_variants")
      .update({ reserved_quantity: 1 })
      .eq("id", variant.id);
    await postStripe(
      checkoutEvent("checkout.session.async_payment_failed", {
        id: session.id,
        payment_status: "unpaid",
        metadata: { order_id: order.id, order_ref: order.order_ref },
      }),
    );
    await sleep(1500);
    texts.payment_failed = await latestOutbound(frId, order.order_ref);
    console.log("\n--- payment failed ---");
    console.log(texts.payment_failed);
  }

  // ----- dispatch + delivery -----
  let deliveredOrder = null;
  {
    const order = await createOrder({
      businessId: business.id,
      customerId: frId,
      status: "PAID",
      totalPence: unitPrice,
      variantId: variant.id,
      unitPrice,
      shippingAddress: BAKER,
      historyTo: "PAID",
      historyFrom: "AWAITING_PAYMENT",
    });
    const quoted = await apiPost(ownerToken, `/api/orders/${order.id}/shipping-rates`, {});
    if (quoted.status !== 200 || !quoted.json.rates?.[0]) {
      texts.dispatch = `ERROR quoting rates: ${quoted.status} ${JSON.stringify(quoted.json)}`;
      texts.delivery = "SKIPPED (no dispatch)";
      console.log("\n--- dispatch ---");
      console.log(texts.dispatch);
    } else {
      const rate = quoted.json.rates[0];
      const dispatch = await apiPost(ownerToken, `/api/orders/${order.id}/dispatch`, {
        rateObjectId: rate.objectId,
        shipmentId: quoted.json.shipmentId,
        carrier: rate.carrier,
      });
      await sleep(1500);
      texts.dispatch = await latestOutbound(frId, order.order_ref);
      console.log("\n--- dispatch ---");
      console.log(`dispatch API: ${dispatch.status} ${JSON.stringify(dispatch.json)}`);
      console.log(texts.dispatch);

      const deliver = await apiPost(ownerToken, `/api/orders/${order.id}/deliver`, {});
      await sleep(1000);
      texts.delivery = await latestOutbound(frId, "livrée");
      if (!texts.delivery) {
        texts.delivery = await latestOutbound(frId, order.order_ref);
      }
      console.log("\n--- delivery ---");
      console.log(`deliver API: ${deliver.status} ${JSON.stringify(deliver.json)}`);
      console.log(texts.delivery);
      deliveredOrder = order;
    }
  }

  // Ensure a DELIVERED order for returns if Shippo path failed
  if (!deliveredOrder) {
    deliveredOrder = await createOrder({
      businessId: business.id,
      customerId: frId,
      status: "DELIVERED",
      totalPence: unitPrice,
      variantId: variant.id,
      unitPrice,
      historyTo: "DELIVERED",
      historyFrom: "DISPATCHED",
    });
  } else {
    await admin
      .from("orders")
      .update({ status: "DELIVERED" })
      .eq("id", deliveredOrder.id)
      .eq("status", "DISPATCHED");
  }

  // Refresh delivered status
  {
    const { data: row } = await admin
      .from("orders")
      .select("id, order_ref, status, thread_id")
      .eq("id", deliveredOrder.id)
      .single();
    deliveredOrder = row;
    if (row.status !== "DELIVERED") {
      await admin.from("orders").update({ status: "DELIVERED" }).eq("id", row.id);
      deliveredOrder.status = "DELIVERED";
    }
  }

  // ----- return requested -----
  {
    // Seed inbound so thread exists
    await admin.from("messages").insert({
      business_id: business.id,
      customer_id: frId,
      channel: "whatsapp",
      direction: "inbound",
      normalised_text: "bonjour",
      thread_id: deliveredOrder.thread_id,
      raw_payload: {},
    });
    const send = await sendWa(
      FR_PHONE,
      `Je voudrais retourner la commande ${deliveredOrder.order_ref}, elle est arrivée abîmée`,
    );
    await sleep(2000);
    texts.return_requested =
      send.json?.support?.reply ??
      (await latestOutbound(frId, deliveredOrder.order_ref));
    console.log("\n--- return requested ---");
    console.log(`webhook support=${JSON.stringify(send.json?.support)}`);
    console.log(texts.return_requested);
  }

  // ----- return approved -----
  {
    const { data: reqOrder } = await admin
      .from("orders")
      .select("id, order_ref, status")
      .eq("id", deliveredOrder.id)
      .single();
    if (reqOrder.status !== "RETURN_REQUESTED") {
      await admin
        .from("orders")
        .update({
          status: "RETURN_REQUESTED",
          return_reason: "damaged_faulty",
          return_reason_detail: "arrivée abîmée",
        })
        .eq("id", reqOrder.id);
    }
    const decide = await apiPost(
      ownerToken,
      `/api/orders/${deliveredOrder.id}/return-decision`,
      { decision: "approve" },
    );
    await sleep(1000);
    texts.return_approved =
      (await latestOutbound(frId, "approuvé")) ||
      (await latestOutbound(frId, "approved")) ||
      (await latestOutbound(frId, deliveredOrder.order_ref));
    console.log("\n--- return approved ---");
    console.log(`decide=${decide.status} ${JSON.stringify(decide.json)}`);
    console.log(texts.return_approved);
  }

  // ----- return declined (with seller policy) -----
  {
    const declineOrder = await createOrder({
      businessId: business.id,
      customerId: frId,
      status: "RETURN_REQUESTED",
      totalPence: unitPrice,
      variantId: variant.id,
      unitPrice,
      historyTo: "RETURN_REQUESTED",
      historyFrom: "DELIVERED",
    });
    await admin
      .from("orders")
      .update({
        return_reason: "changed_mind",
        return_reason_detail: null,
      })
      .eq("id", declineOrder.id);
    const decide = await apiPost(
      ownerToken,
      `/api/orders/${declineOrder.id}/return-decision`,
      { decision: "decline" },
    );
    await sleep(1000);
    texts.return_declined =
      (await latestOutbound(frId, "n'a pas été approuvé")) ||
      (await latestOutbound(frId, declineOrder.order_ref));
    console.log("\n--- return declined ---");
    console.log(`decide=${decide.status} ${JSON.stringify(decide.json)}`);
    console.log(texts.return_declined);
  }

  // ----- refund -----
  {
    // Need a DELIVERED/RETURNED order with a payment intent for Stripe refund.
    // Create via checkout + fulfil, then refund — or use build path via API if PI exists.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: unitPrice,
            product_data: { name: product.name },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        transfer_data: { destination: business.stripe_connected_account_id },
        metadata: {},
      },
      success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE}/pay/cancelled`,
    });
    // Confirm PI if present
    const live = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["payment_intent"],
    });
    let piId =
      typeof live.payment_intent === "string"
        ? live.payment_intent
        : live.payment_intent?.id;
    if (piId) {
      try {
        await stripe.paymentIntents.confirm(piId, {
          payment_method: "pm_card_visa",
          return_url: `${BASE}/pay/success`,
        });
      } catch {
        /* may already require action / succeed */
      }
    }
    const refundOrder = await createOrder({
      businessId: business.id,
      customerId: frId,
      status: "DELIVERED",
      totalPence: unitPrice,
      variantId: variant.id,
      unitPrice,
      checkoutSessionId: session.id,
      paymentIntentId: piId ?? null,
      historyTo: "DELIVERED",
      historyFrom: "DISPATCHED",
    });
    if (piId) {
      await admin
        .from("orders")
        .update({ stripe_payment_intent_id: piId })
        .eq("id", refundOrder.id);
    }
    // Prefer marking as PAID-like for refundable statuses — DELIVERED is refundable
    const refundResp = await apiPost(ownerToken, `/api/orders/${refundOrder.id}/refund`, {
      amountPence: unitPrice,
      reason: "requested_by_customer",
    });
    await sleep(800);
    // If Stripe refund created, fire refund.updated succeeded
    if (refundResp.json?.stripeRefundId) {
      await postStripe(
        refundUpdatedEvent({
          id: refundResp.json.stripeRefundId,
          object: "refund",
          status: "succeeded",
          amount: unitPrice,
          currency: "gbp",
          payment_intent: piId,
          metadata: { order_id: refundOrder.id },
        }),
      );
      await sleep(1200);
    }
    texts.refund =
      (await latestOutbound(frId, "remboursement")) ||
      (await latestOutbound(frId, refundOrder.order_ref));
    console.log("\n--- refund ---");
    console.log(`refund API=${refundResp.status} ${JSON.stringify(refundResp.json)}`);
    console.log(texts.refund);
  }

  // ----- 12h reminder -----
  {
    if (!CRON_SECRET) throw new Error("CRON_SHARED_SECRET missing");
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: unitPrice,
            product_data: { name: product.name },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        transfer_data: { destination: business.stripe_connected_account_id },
      },
      metadata: {},
      success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE}/pay/cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 23 * 3600,
    });
    const order = await createOrder({
      businessId: business.id,
      customerId: frId,
      status: "AWAITING_PAYMENT",
      totalPence: unitPrice,
      variantId: variant.id,
      unitPrice,
      checkoutSessionId: session.id,
      reservedUntil: new Date(Date.now() + 23 * 3600_000).toISOString(),
      historyTo: "AWAITING_PAYMENT",
      historyFrom: "PENDING_CONFIRMATION",
      historyAt: new Date(Date.now() - 12.25 * 3600_000).toISOString(),
    });
    await admin
      .from("orders")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", order.id);
    const cron = await fetch(`${BASE}/api/cron/payment-chase`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": CRON_SECRET,
      },
      body: "{}",
    });
    const cronJson = await cron.json().catch(() => ({}));
    await sleep(1500);
    texts.reminder_12h =
      (await latestOutbound(frId, "Petit rappel")) ||
      (await latestOutbound(frId, order.order_ref));
    console.log("\n--- 12h reminder ---");
    console.log(`cron=${cron.status} hit=${JSON.stringify((cronJson.reminders12h ?? []).find((r) => r.orderId === order.id))}`);
    console.log(texts.reminder_12h);
  }

  // ----- auto-cancel -----
  {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: unitPrice,
            product_data: { name: product.name },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        transfer_data: { destination: business.stripe_connected_account_id },
      },
      success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE}/pay/cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const order = await createOrder({
      businessId: business.id,
      customerId: frId,
      status: "AWAITING_PAYMENT",
      totalPence: unitPrice,
      variantId: variant.id,
      unitPrice,
      checkoutSessionId: session.id,
      reservedUntil: new Date(Date.now() - 60_000).toISOString(),
      historyTo: "AWAITING_PAYMENT",
      historyFrom: "PENDING_CONFIRMATION",
      historyAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    });
    const cron = await fetch(`${BASE}/api/cron/payment-chase`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": CRON_SECRET,
      },
      body: "{}",
    });
    const cronJson = await cron.json().catch(() => ({}));
    await sleep(1500);
    texts.auto_cancel =
      (await latestOutbound(frId, "n'avons pas reçu le paiement")) ||
      (await latestOutbound(frId, "cancelled because")) ||
      (await latestOutbound(frId, order.order_ref));
    console.log("\n--- auto-cancel ---");
    console.log(`cron=${cron.status} cancels=${JSON.stringify(cronJson.autoCancels ?? cronJson.cancels ?? cronJson)}`);
    console.log(texts.auto_cancel);
  }

  // ----- German support + catalogue -----
  const deId = await ensureCustomer(business.id, DE_PHONE, "de");
  await cleanCustomer(business.id, deId);
  await admin.from("customers").update({ preferred_language: "de" }).eq("id", deId);

  {
    const cat = await sendWa(DE_PHONE, "Habt ihr Tassen in Blau?");
    await sleep(2000);
    texts.de_catalog =
      cat.json?.support?.reply ??
      cat.json?.draft?.confirmationMessage ??
      cat.json?.draft?.message ??
      (await latestOutbound(deId, null));
    console.log("\n--- DE catalogue/order 'Habt ihr Tassen in Blau?' ---");
    console.log(`intent path draft=${JSON.stringify(cat.json?.draft)} support=${JSON.stringify(cat.json?.support)}`);
    console.log(texts.de_catalog);
  }

  {
    const q = await sendWa(DE_PHONE, "Wann habt ihr geöffnet?");
    await sleep(2000);
    texts.de_support =
      q.json?.support?.reply ?? (await latestOutbound(deId, null));
    console.log("\n--- DE support 'Wann habt ihr geöffnet?' ---");
    console.log(`support=${JSON.stringify(q.json?.support)}`);
    console.log(texts.de_support);
  }

  // ----- Full French returns policy reply -----
  await admin.from("customers").update({ preferred_language: "fr" }).eq("id", frId);
  {
    const q = await sendWa(FR_PHONE, "Quelle est votre politique de retour ?");
    await sleep(2000);
    texts.fr_policy_reply =
      q.json?.support?.reply ?? (await latestOutbound(frId, null));
    const { data: biz } = await admin
      .from("businesses")
      .select("returns_policy_text")
      .eq("id", business.id)
      .single();
    texts.fr_policy_seller = biz.returns_policy_text;
    console.log("\n--- FR returns policy Q ---");
    console.log("SELLER POLICY TEXT:");
    console.log(texts.fr_policy_seller);
    console.log("BUYER REPLY:");
    console.log(texts.fr_policy_reply);
  }

  // restore policy if we overwrote a different one
  if (priorPolicy !== POLICY) {
    await admin
      .from("businesses")
      .update({ returns_policy_text: priorPolicy })
      .eq("id", business.id);
  }

  console.log("\n\n========== EXACT TEXTS SUMMARY ==========\n");
  for (const [k, v] of Object.entries(texts)) {
    console.log(`### ${k}`);
    console.log(v ?? "(null)");
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
