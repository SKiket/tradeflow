/**
 * Verifies support_reply catalog Q&A (existence, price, availability)
 * without changing order_parse classification.
 *
 *  1. In-stock catalog item → accurate answer, no escalate
 *  2. Real variant at 0 available → honest out-of-stock, no false "in stock"
 *  3. Item not in catalog → escalate_to_seller
 *  4. Returns-policy question still answers from returns_policy_text
 *  5. Order message still goes through draft-order, not support_reply
 *
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-support-catalog.mjs
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
const RETURNS_TEXT = "Returns accepted within 14 days, unworn, with tags";

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
    ProfileName: "Catalog Support Tester",
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

async function parseIntent(messageId) {
  const { data } = await admin
    .from("messages")
    .select("ai_parse_result")
    .eq("id", messageId)
    .maybeSingle();
  return data?.ai_parse_result?.intent ?? null;
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
  const select =
    "id, name, price_pence, product_variants(id, label, stock_quantity, reserved_quantity, track_inventory, deleted_at)";
  let { data: products } = await admin
    .from("products")
    .select(select)
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
    .select(select)
    .eq("business_id", businessId)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("description", "%[order_parse_seed]%");
  return refreshed.data ?? [];
}

function liveVariants(product) {
  return (product.product_variants ?? []).filter((v) => !v.deleted_at);
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

  const products = await ensureCatalog(business.id);
  const blueMug = products.find((p) => /blue mug/i.test(p.name));
  const tote = products.find((p) => /tote/i.test(p.name));
  const navy = liveVariants(tote ?? {}).find((v) => /navy/i.test(v.label ?? ""));
  if (!blueMug) throw new Error("Classic Blue Mug not in seed catalog");
  if (!navy) throw new Error("Linen Tote Navy variant not in seed catalog");

  const mugPrice = `£${(blueMug.price_pence / 100).toFixed(2)}`;
  const previous = {
    returns_policy_text: business.returns_policy_text,
    dispatch_days: business.dispatch_days,
    seller_whatsapp_phone_e164: business.seller_whatsapp_phone_e164,
  };
  const navySnapshot = {
    stock_quantity: navy.stock_quantity,
    reserved_quantity: navy.reserved_quantity,
  };

  await admin
    .from("businesses")
    .update({
      returns_policy_text: RETURNS_TEXT,
      dispatch_days: ["monday", "wednesday", "friday"],
      seller_whatsapp_phone_e164: SELLER,
    })
    .eq("id", business.id);

  try {
    await cleanBuyerState(business.id);
    const q1 = "do you have the classic blue mug?";
    const c1 = await sendWhatsApp(q1);
    const intent1 = await parseIntent(c1.json.messageId);
    const s1 = c1.json.support;
    const reply1 = s1?.reply ?? "";
    const c1Pass =
      c1.status === 200 &&
      intent1 === "question" &&
      s1?.action === "answered" &&
      s1?.escalateToSeller === false &&
      !c1.json.draft &&
      /mug/i.test(reply1) &&
      (/£\s*12(\.00)?/i.test(reply1) ||
        /12\.00/.test(reply1) ||
        reply1.includes(mugPrice)) &&
      /(in stock|available|we have|yes)/i.test(reply1) &&
      !/out of stock/i.test(reply1);
    record(
      "1. In-stock catalog question answered with real price/availability (no escalate)",
      c1Pass,
      `intent=${intent1} action=${s1?.action} escalate=${s1?.escalateToSeller}\nreply=${reply1}`,
    );
    transcripts.push({ case: "1 — in stock", inbound: q1, reply: reply1 });

    await cleanBuyerState(business.id);
    await admin
      .from("product_variants")
      .update({ stock_quantity: navySnapshot.reserved_quantity ?? 0 })
      .eq("id", navy.id);
    const q2 = "do you have the linen tote in navy?";
    const c2 = await sendWhatsApp(q2);
    const intent2 = await parseIntent(c2.json.messageId);
    const s2 = c2.json.support;
    const reply2 = s2?.reply ?? "";
    const claimsInStock = /(yes[,.]?\s+we have|in stock|available to (buy|order))/i.test(
      reply2,
    ) && !/(out of stock|unavailable|don't have|do not have|sold out|not currently)/i.test(reply2);
    const honestOos =
      /(out of stock|unavailable|don't have|do not have|sold out|not currently available|currently out)/i.test(
        reply2,
      );
    const c2Pass =
      c2.status === 200 &&
      intent2 === "question" &&
      s2?.escalateToSeller === false &&
      !c2.json.draft &&
      honestOos &&
      !claimsInStock;
    record(
      "2. Out-of-stock variant answered honestly (not a false in-stock)",
      c2Pass,
      `intent=${intent2} action=${s2?.action} escalate=${s2?.escalateToSeller}\nreply=${reply2}`,
    );
    transcripts.push({ case: "2 — out of stock", inbound: q2, reply: reply2 });
    await admin
      .from("product_variants")
      .update({ stock_quantity: navySnapshot.stock_quantity })
      .eq("id", navy.id);

    await cleanBuyerState(business.id);
    const q3 = "do you have umbrellas?";
    const c3 = await sendWhatsApp(q3);
    const intent3 = await parseIntent(c3.json.messageId);
    const s3 = c3.json.support;
    const reply3 = s3?.reply ?? "";
    const claimsUmbrella =
      /(yes[,.]?\s+we (do )?have umbrellas|we (do )?sell umbrellas|we carry umbrellas)/i.test(
        reply3,
      );
    const c3Pass =
      c3.status === 200 &&
      intent3 === "question" &&
      s3?.action === "escalated" &&
      s3?.escalateToSeller === true &&
      !c3.json.draft &&
      /seller/i.test(reply3) &&
      !claimsUmbrella;
    record(
      "3. Item not in catalog escalates (no invention)",
      c3Pass,
      `intent=${intent3} action=${s3?.action} escalate=${s3?.escalateToSeller}\nreply=${reply3}`,
    );
    transcripts.push({ case: "3 — not in catalog", inbound: q3, reply: reply3 });

    await cleanBuyerState(business.id);
    const q4 = "what's your return policy?";
    const c4 = await sendWhatsApp(q4);
    const intent4 = await parseIntent(c4.json.messageId);
    const s4 = c4.json.support;
    const reply4 = s4?.reply ?? "";
    const c4Pass =
      c4.status === 200 &&
      intent4 === "question" &&
      s4?.action === "answered" &&
      s4?.escalateToSeller === false &&
      !c4.json.draft &&
      /return/i.test(reply4) &&
      (/14\s*days/i.test(reply4) ||
        /fourteen/i.test(reply4) ||
        /unworn/i.test(reply4) ||
        /tags/i.test(reply4));
    record(
      "4. Returns-policy question still answered from returns_policy_text",
      c4Pass,
      `intent=${intent4} action=${s4?.action} escalate=${s4?.escalateToSeller}\nreply=${reply4}`,
    );
    transcripts.push({ case: "4 — returns policy", inbound: q4, reply: reply4 });

    await cleanBuyerState(business.id);
    const q5 = "I'd like 2 of the blue mug";
    const c5 = await sendWhatsApp(q5);
    const intent5 = await parseIntent(c5.json.messageId);
    const d5 = c5.json.draft;
    const { data: pending } = await admin
      .from("orders")
      .select("id, status")
      .eq("business_id", business.id)
      .eq("status", "PENDING_CONFIRMATION");
    const c5Pass =
      c5.status === 200 &&
      intent5 === "order" &&
      !c5.json.support &&
      (d5?.action === "draft_created" ||
        d5?.action === "draft_updated" ||
        ((pending ?? []).length === 1 && d5?.action === "error"));
    record(
      "5. Order message still classified as order and creates a draft",
      c5Pass,
      `intent=${intent5} draft=${JSON.stringify(d5)}\nsupport=${JSON.stringify(c5.json.support ?? null)}`,
    );
    transcripts.push({
      case: "5 — order (unaffected)",
      inbound: q5,
      reply: d5?.confirmationMessage ?? d5?.message ?? null,
    });

    await cleanBuyerState(business.id);
  } finally {
    await admin
      .from("product_variants")
      .update({ stock_quantity: navySnapshot.stock_quantity })
      .eq("id", navy.id);
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
    console.log(`Inbound: ${t.inbound}`);
    console.log(`Reply:\n${t.reply ?? "(none)"}`);
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log("\n========================================");
  console.log(
    failed === 0
      ? "SUPPORT CATALOG VERIFICATION: PASSED"
      : `SUPPORT CATALOG VERIFICATION: ${failed} FAILED`,
  );
  console.log("========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
