/**
 * Verifies support_reply order-status grounding and complaint escalation.
 *
 *  1. Customer with a DISPATCHED order: "where's my order?" cites real tracking
 *  2. Customer with a PAID (not dispatched) order: honest status, no fake tracking
 *  3. "this arrived broken" → escalate_to_seller, seller WhatsApp, no promised fix
 *  4. Customer with no orders: honest cannot-find reply
 *  5. Catalog + returns-policy questions still work (E3 / Step 14, no regression)
 *  6. Reports order_parse intent for "where's my order?"
 *
 * Uses dedicated test phones so live buyer orders are not deleted.
 *
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-support-order-status.mjs
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const SELLER = process.env.SELLER_PHONE ?? "+447733308706";
const RETURNS_TEXT = "Returns accepted within 14 days, unworn, with tags";
const DISPATCHED_BUYER = "+447700900201";
const PAID_BUYER = "+447700900202";
const NONE_BUYER = "+447700900203";
const TRACKING = "00000000000000";
const CARRIER = "Hermes UK";

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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
const transcripts = [];

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

async function sendWhatsApp(fromPhone, bodyText) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${fromPhone}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Order Status Tester",
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

function sendHandled(send) {
  if (!send) return false;
  if (send.ok === true) return true;
  return typeof send.error === "string" && send.error.length > 0;
}

function promisesResolution(text) {
  return (
    /\b(refund|replace|replacement)\b/i.test(text) &&
    /(we('ll| will)|i('ll| will)|happy to|can refund|send you a new|new one on (its|the) way)/i.test(
      text,
    )
  );
}

async function parseIntent(messageId) {
  const { data } = await admin
    .from("messages")
    .select("ai_parse_result")
    .eq("id", messageId)
    .maybeSingle();
  return data?.ai_parse_result ?? null;
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
  const orderRef = `TF-STAT-${randomBytes(3).toString("hex").toUpperCase()}`;
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
      dispatch_carrier: params.carrier ?? null,
      dispatch_tracking_number: params.tracking ?? null,
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

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select(
      "id, name, whatsapp_phone_e164, returns_policy_text, dispatch_days, seller_whatsapp_phone_e164",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (business.whatsapp_phone_e164 !== SANDBOX_NUMBER) {
    throw new Error("Sandbox number not mapped to EK-Pousser_D");
  }

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
    dispatch_days: business.dispatch_days,
    seller_whatsapp_phone_e164: business.seller_whatsapp_phone_e164,
  };

  await admin
    .from("businesses")
    .update({
      returns_policy_text: RETURNS_TEXT,
      dispatch_days: ["monday", "wednesday", "friday"],
      seller_whatsapp_phone_e164: SELLER,
    })
    .eq("id", business.id);

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Mug variant: ${mugVariant.id} @ ${mug.price_pence}p\n`);

  try {
    await cleanPhone(business.id, DISPATCHED_BUYER);
    await cleanPhone(business.id, PAID_BUYER);
    await cleanPhone(business.id, NONE_BUYER);

    const dispatchedCustomer = await ensureCustomer(
      business.id,
      DISPATCHED_BUYER,
      "Dispatched Tester",
    );
    const dispatchedOrder = await createOrder({
      businessId: business.id,
      customerId: dispatchedCustomer,
      status: "DISPATCHED",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
      carrier: CARRIER,
      tracking: TRACKING,
    });

    const paidCustomer = await ensureCustomer(
      business.id,
      PAID_BUYER,
      "Paid Tester",
    );
    const paidOrder = await createOrder({
      businessId: business.id,
      customerId: paidCustomer,
      status: "PAID",
      variantId: mugVariant.id,
      unitPrice: mug.price_pence,
    });

    // ========== 1. DISPATCHED status question ==========
    const q1 = "where's my order?";
    const c1 = await sendWhatsApp(DISPATCHED_BUYER, q1);
    const parse1 = await parseIntent(c1.json.messageId);
    const s1 = c1.json.support;
    const reply1 = s1?.reply ?? "";
    const c1Pass =
      c1.status === 200 &&
      c1.json.parseStored === true &&
      parse1?.intent === "question" &&
      s1?.action === "answered" &&
      s1?.escalateToSeller === false &&
      !c1.json.draft &&
      reply1.includes(dispatchedOrder.order_ref) &&
      (reply1.includes(TRACKING) || /hermes/i.test(reply1)) &&
      sendHandled(s1?.buyerSend);
    record(
      "1. DISPATCHED customer: where's my order? cites real carrier/tracking, no escalate",
      c1Pass,
      `intent=${parse1?.intent} action=${s1?.action} escalate=${s1?.escalateToSeller}\norder=${dispatchedOrder.order_ref}\nreply=${reply1}`,
    );
    transcripts.push({
      case: "1 — DISPATCHED status",
      inbound: q1,
      from: DISPATCHED_BUYER,
      reply: reply1,
      intent: parse1?.intent,
      escalate: s1?.escalateToSeller,
    });

    // ========== 2. PAID not dispatched ==========
    const q2 = "where's my order?";
    const c2 = await sendWhatsApp(PAID_BUYER, q2);
    const parse2 = await parseIntent(c2.json.messageId);
    const s2 = c2.json.support;
    const reply2 = s2?.reply ?? "";
    const inventedTracking =
      /\b\d{10,}\b/.test(reply2) || /hermes/i.test(reply2);
    const c2Pass =
      c2.status === 200 &&
      parse2?.intent === "question" &&
      s2?.action === "answered" &&
      s2?.escalateToSeller === false &&
      !c2.json.draft &&
      reply2.includes(paidOrder.order_ref) &&
      /paid|not (yet )?dispatch|awaiting dispatch|being (prepared|packed)|hasn'?t (been )?dispatch|has not been dispatch|received payment|we('ve| have) (got|received) (your )?payment|being processed|on (its|the) way to (being )?dispatch/i.test(
        reply2,
      ) &&
      !inventedTracking &&
      sendHandled(s2?.buyerSend);
    record(
      "2. PAID (not dispatched) customer: honest status, no fabricated tracking",
      c2Pass,
      `intent=${parse2?.intent} action=${s2?.action} escalate=${s2?.escalateToSeller}\norder=${paidOrder.order_ref}\nreply=${reply2}`,
    );
    transcripts.push({
      case: "2 — PAID not dispatched",
      inbound: q2,
      from: PAID_BUYER,
      reply: reply2,
      intent: parse2?.intent,
      escalate: s2?.escalateToSeller,
    });

    // ========== 3. Complaint ==========
    const q3 = "this arrived broken";
    const c3 = await sendWhatsApp(DISPATCHED_BUYER, q3);
    const parse3 = await parseIntent(c3.json.messageId);
    const s3 = c3.json.support;
    const reply3 = s3?.reply ?? "";
    const sellerText = s3?.sellerNotify?.text ?? "";
    const c3Pass =
      c3.status === 200 &&
      (parse3?.intent === "question" || c3.json.parseStored === true) &&
      s3?.action === "escalated" &&
      s3?.escalateToSeller === true &&
      !c3.json.draft &&
      /passed|EK-Pousser|seller|team/i.test(reply3) &&
      !promisesResolution(reply3) &&
      s3?.sellerNotify?.attempted === true &&
      sendHandled(s3?.sellerNotify) &&
      sellerText.toLowerCase().includes(q3) &&
      sendHandled(s3?.buyerSend);
    record(
      "3. Complaint escalates; seller notified with complaint text; no promised resolution",
      c3Pass,
      `intent=${parse3?.intent} action=${s3?.action} escalate=${s3?.escalateToSeller}\nbuyerReply=${reply3}\nsellerText=${sellerText}`,
    );
    transcripts.push({
      case: "3 — complaint",
      inbound: q3,
      from: DISPATCHED_BUYER,
      reply: reply3,
      seller: sellerText,
      intent: parse3?.intent,
      escalate: s3?.escalateToSeller,
    });

    // ========== 4. No orders ==========
    await ensureCustomer(business.id, NONE_BUYER, "No Orders Tester");
    const q4 = "where's my order?";
    const c4 = await sendWhatsApp(NONE_BUYER, q4);
    const parse4 = await parseIntent(c4.json.messageId);
    const s4 = c4.json.support;
    const reply4 = s4?.reply ?? "";
    const hallucinatedRef = /TF-[A-Z0-9]+/i.test(reply4);
    const c4Pass =
      c4.status === 200 &&
      parse4?.intent === "question" &&
      s4?.action === "answered" &&
      s4?.escalateToSeller === false &&
      !c4.json.draft &&
      /(can'?t (seem to )?find|couldn'?t find|don'?t have .{0,40}orders?|no (orders? )?on file|orders? on file)/i.test(
        reply4,
      ) &&
      !hallucinatedRef &&
      sendHandled(s4?.buyerSend);
    record(
      "4. Customer with no orders: honest cannot-find reply, no invented status",
      c4Pass,
      `intent=${parse4?.intent} action=${s4?.action} escalate=${s4?.escalateToSeller}\nreply=${reply4}`,
    );
    transcripts.push({
      case: "4 — no orders",
      inbound: q4,
      from: NONE_BUYER,
      reply: reply4,
      intent: parse4?.intent,
      escalate: s4?.escalateToSeller,
    });

    // ========== 5. Catalog + returns regression ==========
    const q5a = "do you have the classic blue mug?";
    const c5a = await sendWhatsApp(NONE_BUYER, q5a);
    const parse5a = await parseIntent(c5a.json.messageId);
    const s5a = c5a.json.support;
    const reply5a = s5a?.reply ?? "";
    const mugPrice = `£${(mug.price_pence / 100).toFixed(2)}`;
    const catalogPass =
      parse5a?.intent === "question" &&
      s5a?.escalateToSeller === false &&
      /mug/i.test(reply5a) &&
      (reply5a.includes(mugPrice) || /12(\.00)?/.test(reply5a));

    const q5b = "what's your return policy?";
    const c5b = await sendWhatsApp(NONE_BUYER, q5b);
    const parse5b = await parseIntent(c5b.json.messageId);
    const s5b = c5b.json.support;
    const reply5b = s5b?.reply ?? "";
    const returnsPass =
      parse5b?.intent === "question" &&
      s5b?.escalateToSeller === false &&
      /return/i.test(reply5b) &&
      (/14\s*days/i.test(reply5b) || /unworn/i.test(reply5b) || /tags/i.test(reply5b));

    record(
      "5. Catalog Q&A and returns-policy answers still work (no regression)",
      catalogPass && returnsPass,
      `catalog intent=${parse5a?.intent} escalate=${s5a?.escalateToSeller}\nreply=${reply5a}\nreturns intent=${parse5b?.intent} escalate=${s5b?.escalateToSeller}\nreply=${reply5b}`,
    );
    transcripts.push({
      case: "5a — catalog (regression)",
      inbound: q5a,
      from: NONE_BUYER,
      reply: reply5a,
      intent: parse5a?.intent,
      escalate: s5a?.escalateToSeller,
    });
    transcripts.push({
      case: "5b — returns policy (regression)",
      inbound: q5b,
      from: NONE_BUYER,
      reply: reply5b,
      intent: parse5b?.intent,
      escalate: s5b?.escalateToSeller,
    });

    // ========== 6. Intent classification finding ==========
    record(
      "6. order_parse classifies 'where's my order?' as question (reaches support_reply)",
      parse1?.intent === "question" && Boolean(c1.json.support) && !c1.json.draft,
      `intent=${parse1?.intent} confidence=${parse1?.confidence} supportAction=${s1?.action} draft=${JSON.stringify(c1.json.draft ?? null)}`,
    );
    transcripts.push({
      case: "6 — order_parse intent",
      inbound: q1,
      from: DISPATCHED_BUYER,
      reply: `(intent=${parse1?.intent}, confidence=${parse1?.confidence})`,
      intent: parse1?.intent,
      escalate: s1?.escalateToSeller,
    });
  } finally {
    await cleanPhone(business.id, DISPATCHED_BUYER);
    await cleanPhone(business.id, PAID_BUYER);
    await cleanPhone(business.id, NONE_BUYER);
    await admin
      .from("businesses")
      .update({
        returns_policy_text: previous.returns_policy_text,
        dispatch_days: previous.dispatch_days,
        seller_whatsapp_phone_e164: previous.seller_whatsapp_phone_e164,
      })
      .eq("id", business.id);
  }

  console.log("\n========================================");
  console.log("EXACT REPLY TEXT");
  console.log("========================================");
  for (const t of transcripts) {
    console.log(`\n--- ${t.case} ---`);
    console.log(`From: ${t.from}`);
    console.log(`Inbound: ${t.inbound}`);
    console.log(`intent=${t.intent} escalate=${t.escalate}`);
    console.log(`Buyer-facing:\n${t.reply ?? "(none)"}`);
    if (t.seller) console.log(`Seller-facing:\n${t.seller}`);
  }

  console.log("\n========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
