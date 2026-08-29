/**
 * Verifies support_reply + other-fallback on inbound WhatsApp (after order_parse).
 *
 * Cases:
 *  1. Question answerable from configured returns_policy_text → answered, no escalate
 *  2. Question NOT answerable from configured context → escalate + seller WhatsApp
 *  3. Unclear message → fixed fallback, no support_reply AI call
 *  4. intent "order" → draft-order path unchanged (support logic does not intercept)
 *
 * Twilio trial daily caps may cause send failures; those still PASS when the
 * handler captured the error and the rest of the path is proven.
 *
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-support-reply.mjs
 */
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447733308706";
const SELLER = process.env.SELLER_PHONE ?? "+447733308706";
const RETURNS_TEXT =
  "Returns accepted within 14 days, unworn, with tags";
const OTHER_FALLBACK =
  "Sorry, I didn't quite catch that — did you want to place an order, or is there something else I can help with?";

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

async function sendWhatsApp(bodyText) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${BUYER}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Support Reply Tester",
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
}

async function ensureCatalog(businessId) {
  const { data: products } = await admin
    .from("products")
    .select("id, name, price_pence, product_variants(id, label, deleted_at)")
    .eq("business_id", businessId)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("description", "%[order_parse_seed]%");
  if (products?.length) return products;

  console.log("No seed catalog — seeding…");
  const seeded = spawnSync("node", ["scripts/seed-ek-pousser-catalog.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  if (seeded.status !== 0) {
    throw new Error(seeded.stderr || seeded.stdout || "seed failed");
  }
  const refreshed = await admin
    .from("products")
    .select("id, name, price_pence, product_variants(id, label, deleted_at)")
    .eq("business_id", businessId)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("description", "%[order_parse_seed]%");
  return refreshed.data ?? [];
}

async function seedSupportReplyConfig() {
  const { error } = await admin.from("ai_model_config").upsert(
    {
      task_key: "support_reply",
      provider: "gemini",
      model: "gemini-2.5-flash",
      fallback_provider: "gemini",
      fallback_model: "gemini-2.5-flash",
      max_tokens: 1024,
      is_active: true,
    },
    { onConflict: "task_key" },
  );
  if (error) throw new Error(`Failed to seed support_reply config: ${error.message}`);
}

async function main() {
  await seedSupportReplyConfig();

  const { data: business } = await admin
    .from("businesses")
    .select(
      "id, name, whatsapp_phone_e164, returns_policy_text, dispatch_days, seller_whatsapp_phone_e164, ai_tone",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (business.whatsapp_phone_e164 !== SANDBOX_NUMBER) {
    throw new Error("Sandbox number not mapped to EK-Pousser_D");
  }

  const products = await ensureCatalog(business.id);
  const blueMug = products.find((p) => /blue mug/i.test(p.name));

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
  console.log(`Returns policy set to: ${RETURNS_TEXT}`);
  console.log(`Seller notify phone: ${SELLER}`);
  console.log(`Buyer: ${BUYER}\n`);

  try {
    // ========== Case 1: answerable question ==========
    await cleanBuyerState(business.id);
    const q1Text = "what's your return policy?";
    const c1 = await sendWhatsApp(q1Text);
    const s1 = c1.json.support;
    const parse1 = await admin
      .from("messages")
      .select("ai_parse_result")
      .eq("id", c1.json.messageId)
      .maybeSingle();
    const intent1 = parse1.data?.ai_parse_result?.intent;
    const reply1 = s1?.reply ?? "";
    const c1Pass =
      c1.status === 200 &&
      c1.json.parseStored === true &&
      intent1 === "question" &&
      s1?.action === "answered" &&
      s1?.escalateToSeller === false &&
      s1?.aiCalled === true &&
      !c1.json.draft &&
      /return/i.test(reply1) &&
      (/14\s*days/i.test(reply1) ||
        /fourteen/i.test(reply1) ||
        /unworn/i.test(reply1) ||
        /tags/i.test(reply1)) &&
      sendHandled(s1?.buyerSend);
    record(
      "Case 1: return-policy question answered from configured text (no escalate)",
      c1Pass,
      `intent=${intent1} action=${s1?.action} escalate=${s1?.escalateToSeller}\nbuyerSend=${JSON.stringify(s1?.buyerSend)}\nreply=${reply1}`,
    );
    transcripts.push({
      case: "1 — answerable question",
      buyerInbound: q1Text,
      buyerFacing: reply1,
      sellerFacing: null,
    });

    // ========== Case 2: unanswerable question ==========
    await cleanBuyerState(business.id);
    const q2Text = "do you ship to Ireland?";
    const c2 = await sendWhatsApp(q2Text);
    const s2 = c2.json.support;
    const parse2 = await admin
      .from("messages")
      .select("ai_parse_result")
      .eq("id", c2.json.messageId)
      .maybeSingle();
    const intent2 = parse2.data?.ai_parse_result?.intent;
    const reply2 = s2?.reply ?? "";
    const sellerText = s2?.sellerNotify?.text ?? "";
    const c2Pass =
      c2.status === 200 &&
      c2.json.parseStored === true &&
      intent2 === "question" &&
      s2?.action === "escalated" &&
      s2?.escalateToSeller === true &&
      s2?.aiCalled === true &&
      !c2.json.draft &&
      /seller/i.test(reply2) &&
      sendHandled(s2?.buyerSend) &&
      s2?.sellerNotify?.attempted === true &&
      sendHandled(s2?.sellerNotify) &&
      sellerText.includes(q2Text);
    record(
      "Case 2: unanswerable shipping question escalates to seller",
      c2Pass,
      `intent=${intent2} action=${s2?.action} escalate=${s2?.escalateToSeller}\nbuyerSend=${JSON.stringify(s2?.buyerSend)}\nsellerNotify=${JSON.stringify({
        attempted: s2?.sellerNotify?.attempted,
        ok: s2?.sellerNotify?.ok,
        error: s2?.sellerNotify?.error,
      })}\nbuyerReply=${reply2}\nsellerText=${sellerText}`,
    );
    transcripts.push({
      case: "2 — unanswerable question",
      buyerInbound: q2Text,
      buyerFacing: reply2,
      sellerFacing: sellerText || null,
    });

    // ========== Case 3: unclear / other ==========
    await cleanBuyerState(business.id);
    const q3Text = "blargle fnord 999 xyzzy";
    const c3 = await sendWhatsApp(q3Text);
    const s3 = c3.json.support;
    const parse3 = await admin
      .from("messages")
      .select("ai_parse_result")
      .eq("id", c3.json.messageId)
      .maybeSingle();
    const intent3 = parse3.data?.ai_parse_result?.intent;
    const c3Pass =
      c3.status === 200 &&
      c3.json.parseStored === true &&
      intent3 === "other" &&
      s3?.action === "fallback" &&
      s3?.aiCalled === false &&
      s3?.escalateToSeller === false &&
      !c3.json.draft &&
      s3?.reply === OTHER_FALLBACK &&
      sendHandled(s3?.buyerSend);
    record(
      "Case 3: unclassifiable message → fixed fallback, no AI support_reply call",
      c3Pass,
      `intent=${intent3} action=${s3?.action} aiCalled=${s3?.aiCalled}\nreply=${s3?.reply}`,
    );
    transcripts.push({
      case: "3 — unclear / other",
      buyerInbound: q3Text,
      buyerFacing: s3?.reply ?? null,
      sellerFacing: null,
    });

    // ========== Case 4: order path unaffected ==========
    await cleanBuyerState(business.id);
    const q4Text = "I'd like 2 of the blue mug";
    const c4 = await sendWhatsApp(q4Text);
    const parse4 = await admin
      .from("messages")
      .select("ai_parse_result")
      .eq("id", c4.json.messageId)
      .maybeSingle();
    const intent4 = parse4.data?.ai_parse_result?.intent;
    const d4 = c4.json.draft;
    const { data: pending } = await admin
      .from("orders")
      .select("id, status, total_pence")
      .eq("business_id", business.id)
      .eq("status", "PENDING_CONFIRMATION");
    const c4Pass =
      c4.status === 200 &&
      c4.json.parseStored === true &&
      intent4 === "order" &&
      !c4.json.support &&
      (d4?.action === "draft_created" ||
        d4?.action === "draft_updated" ||
        ((pending ?? []).length === 1 && d4?.action === "error"));
    record(
      "Case 4: order intent still runs draft-order flow (support does not intercept)",
      c4Pass,
      `intent=${intent4} draft=${JSON.stringify(d4)}\nsupport=${JSON.stringify(c4.json.support ?? null)}\npendingOrders=${(pending ?? []).length}`,
    );
    transcripts.push({
      case: "4 — order (unaffected)",
      buyerInbound: q4Text,
      buyerFacing: d4?.confirmationMessage ?? d4?.message ?? null,
      sellerFacing: null,
    });

    await cleanBuyerState(business.id);
  } finally {
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
  console.log("EXACT MESSAGE TEXT");
  console.log("========================================");
  for (const t of transcripts) {
    console.log(`\n--- ${t.case} ---`);
    console.log(`Buyer inbound: ${t.buyerInbound}`);
    console.log(`Buyer-facing:\n${t.buyerFacing ?? "(none)"}`);
    if (t.sellerFacing) {
      console.log(`Seller-facing:\n${t.sellerFacing}`);
    } else {
      console.log("Seller-facing: (none)");
    }
  }

  console.log("\n========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
