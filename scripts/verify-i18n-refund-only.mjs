/**
 * Verifies French refund WhatsApp copy for a delivered order.
 *   node scripts/verify-i18n-refund-only.mjs
 */
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import {
  createAdmin,
  deleteOrdersByIds,
  ensureSeedCatalog,
  hashTag,
  liveVariants,
  loadVerifyEnv,
  newRunId,
} from "./lib/verify-harness.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const FR_PHONE = "+447700900301";

const env = loadVerifyEnv();
const admin = createAdmin({ allowPilotWrites: true });
const stripe = new Stripe(env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-06-24.dahlia",
});
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
const url = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const runId = newRunId("i18nrf");

function signStripe(payload, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex")}`;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
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
  const { data: sessionData, error: ve } = await client.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "email",
  });
  if (ve) throw ve;
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

async function main() {
  console.log(`runId=${runId}`);
  const createdOrderIds = [];
  let exitCode = 1;

  const { data: business } = await admin
    .from("businesses")
    .select("id, owner_user_id, stripe_connected_account_id")
    .eq("name", "EK-Pousser_D")
    .single();
  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const token = await signIn(owner.user.email);

  let { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", FR_PHONE)
    .maybeSingle();
  if (!customer) {
    const inserted = await admin
      .from("customers")
      .insert({
        business_id: business.id,
        phone_e164: FR_PHONE,
        name: `I18n Refund ${runId}`,
        preferred_language: "fr",
      })
      .select("id")
      .single();
    customer = inserted.data;
  } else {
    await admin.from("customers").update({ preferred_language: "fr" }).eq("id", customer.id);
  }

  try {
    const products = await ensureSeedCatalog(admin, business.id, {
      select: "id, name, price_pence, product_variants(id, deleted_at)",
    });
    const blueMug = products.find((p) => /blue mug/i.test(p.name)) ?? products[0];
    const variant = liveVariants(blueMug)[0];
    if (!variant) throw new Error("No catalog variant");
    const unitPrice = blueMug.price_pence;
    const orderRef = `IR${hashTag(runId)}${Date.now().toString(36)}`.toUpperCase().slice(0, 24);
    const threadId = crypto.randomUUID();

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .insert({
        business_id: business.id,
        customer_id: customer.id,
        thread_id: threadId,
        channel: "whatsapp",
        status: "AWAITING_PAYMENT",
        total_pence: unitPrice,
        order_ref: orderRef,
        reserved_until: new Date(Date.now() + 3600_000).toISOString(),
      })
      .select("id, order_ref")
      .single();
    if (orderErr || !order) throw new Error(orderErr?.message ?? "order insert failed");
    createdOrderIds.push(order.id);

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
            product_data: { name: "Refund i18n" },
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

    const payload = JSON.stringify({
      id: `evt_test_${Math.random().toString(36).slice(2)}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          object: "checkout.session",
          id: session.id,
          payment_status: "paid",
          metadata: { order_id: order.id, order_ref: orderRef },
        },
      },
    });
    await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signStripe(payload),
      },
      body: payload,
    });
    await sleep(1500);

    await admin.from("orders").update({ status: "DELIVERED" }).eq("id", order.id);

    const refund = await apiPost(token, `/api/orders/${order.id}/refund`, {
      amountPence: unitPrice,
      reason: "requested_by_customer",
    });
    console.log("refund api", refund.status, JSON.stringify(refund.json));

    if (refund.json?.stripeRefundId) {
      const wh = JSON.stringify({
        id: `evt_test_${Math.random().toString(36).slice(2)}`,
        object: "event",
        type: "refund.updated",
        data: {
          object: {
            id: refund.json.stripeRefundId,
            object: "refund",
            status: "succeeded",
            amount: unitPrice,
            currency: "gbp",
            payment_intent: pi.id,
            metadata: { order_id: order.id },
          },
        },
      });
      await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": signStripe(wh),
        },
        body: wh,
      });
      await sleep(1500);
    }

    const { data: msgs } = await admin
      .from("messages")
      .select("normalised_text")
      .eq("customer_id", customer.id)
      .eq("direction", "outbound")
      .ilike("normalised_text", `%${orderRef}%`)
      .order("created_at", { ascending: false })
      .limit(10);

    const refundMsg = (msgs || []).find((m) =>
      /remboursement|refund/i.test(m.normalised_text || ""),
    );
    console.log("--- REFUND TEXT ---");
    console.log(refundMsg?.normalised_text ?? "(not found)\n" + JSON.stringify(msgs, null, 2));

    const passed = Boolean(refundMsg?.normalised_text);
    console.log(passed ? "PASS — French/refund text found" : "FAIL — refund text missing");
    exitCode = passed ? 0 : 1;
  } finally {
    await deleteOrdersByIds(admin, createdOrderIds);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
