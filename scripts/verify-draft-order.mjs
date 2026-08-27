/**
 * Verifies create-draft-order end to end (Step 9).
 *
 * Cases:
 *  a. Unambiguous order → PENDING_CONFIRMATION draft + confirmation WhatsApp
 *  d. Follow-up size correction → same draft updated, not duplicated
 *  b. Not-in-catalog → no order, clarification WhatsApp
 *  stock. Requested qty > available → no order, stock-shortage WhatsApp
 *
 * Sends as +447733308706 so outbound WhatsApp arrives on the sandbox-joined phone.
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-draft-order.mjs
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
    ProfileName: "Draft Order Tester",
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

async function waitForDraft(body, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (body?.draft?.action) return body;
    await sleep(500);
  }
  return body;
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
  // Keep the customer row so WhatsApp continuity is fine; clearing messages
  // forces a fresh thread_id on the next inbound.
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, whatsapp_phone_e164")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (business.whatsapp_phone_e164 !== SANDBOX_NUMBER) {
    throw new Error("Sandbox number not mapped to EK-Pousser_D");
  }

  // Ensure catalog exists
  let { data: products } = await admin
    .from("products")
    .select("id, name, price_pence, product_variants(id, label, stock_quantity, track_inventory, deleted_at)")
    .eq("business_id", business.id)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("description", "%[order_parse_seed]%");

  if (!products?.length) {
    console.log("No seed catalog — seeding…");
    const { spawnSync } = await import("node:child_process");
    const seeded = spawnSync("node", ["scripts/seed-ek-pousser-catalog.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    if (seeded.status !== 0) {
      throw new Error(seeded.stderr || seeded.stdout || "seed failed");
    }
    const refreshed = await admin
      .from("products")
      .select("id, name, price_pence, product_variants(id, label, stock_quantity, track_inventory, deleted_at)")
      .eq("business_id", business.id)
      .eq("active", true)
      .is("deleted_at", null)
      .ilike("description", "%[order_parse_seed]%");
    products = refreshed.data;
  }

  const blueMug = products.find((p) => /blue mug/i.test(p.name));
  const sneakers = products.find((p) => /sneaker/i.test(p.name));
  const mugVariant = (blueMug?.product_variants ?? []).find((v) => !v.deleted_at);
  const size10 = (sneakers?.product_variants ?? []).find(
    (v) => !v.deleted_at && /10/i.test(v.label),
  );
  const size11 = (sneakers?.product_variants ?? []).find(
    (v) => !v.deleted_at && /11/i.test(v.label),
  );

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Buyer: ${BUYER}`);
  console.log(`Blue mug: ${blueMug?.id} @ ${blueMug?.price_pence}p variant=${mugVariant?.id}`);
  console.log(`Sneakers size10/11: ${size10?.id} / ${size11?.id}\n`);

  // ========== Case a ==========
  await cleanBuyerState(business.id);
  const aSend = await sendWhatsApp("I'd like 2 of the blue mug");
  await sleep(2500);
  const aDraft = aSend.json.draft;
  const { data: aOrders } = await admin
    .from("orders")
    .select("id, status, total_pence, order_ref, thread_id, order_items(id, quantity, unit_price_pence, product_variant_id)")
    .eq("business_id", business.id)
    .eq("status", "PENDING_CONFIRMATION")
    .order("created_at", { ascending: false });
  const aOrder = (aOrders ?? [])[0];
  const expectedTotal = (blueMug?.price_pence ?? 0) * 2;
  const aPass =
    aSend.status === 200 &&
    aDraft?.action === "draft_created" &&
    aOrder?.status === "PENDING_CONFIRMATION" &&
    aOrder?.total_pence === expectedTotal &&
    aOrder?.order_items?.length === 1 &&
    aOrder.order_items[0].quantity === 2 &&
    aOrder.order_items[0].product_variant_id === mugVariant?.id;
  record("Case a: confident order → PENDING_CONFIRMATION draft + confirmation WhatsApp", aPass,
    `draft=${JSON.stringify(aDraft)}\norder=${JSON.stringify(aOrder, null, 2)}`);

  // ========== Case d (fresh thread) ==========
  await cleanBuyerState(business.id);
  const d1 = await sendWhatsApp("I'd like the weekend sneakers in size 10");
  await sleep(3000);
  const d1Draft = d1.json.draft;
  const d1OrderId = d1Draft?.orderId;
  const d2 = await sendWhatsApp("actually make it size 11");
  await sleep(3000);
  const d2Draft = d2.json.draft;
  const { data: dOrders } = await admin
    .from("orders")
    .select("id, status, total_pence, order_ref, thread_id, order_items(id, quantity, unit_price_pence, product_variant_id)")
    .eq("business_id", business.id)
    .eq("status", "PENDING_CONFIRMATION");
  const dPass =
    d1Draft?.action === "draft_created" &&
    d2Draft?.action === "draft_updated" &&
    d2Draft?.orderId === d1OrderId &&
    (dOrders ?? []).length === 1 &&
    dOrders[0].id === d1OrderId &&
    dOrders[0].order_items?.length === 1 &&
    dOrders[0].order_items[0].product_variant_id === size11?.id;
  record("Case d: size correction updates SAME draft (no duplicate)", dPass,
    `d1=${JSON.stringify(d1Draft)}\nd2=${JSON.stringify(d2Draft)}\norders=${JSON.stringify(dOrders, null, 2)}`);

  // ========== Case b ==========
  await cleanBuyerState(business.id);
  const bSend = await sendWhatsApp("Can I get a purple hoverboard please?");
  await sleep(2500);
  const bDraft = bSend.json.draft;
  const { data: bOrders } = await admin
    .from("orders")
    .select("id")
    .eq("business_id", business.id)
    .eq("status", "PENDING_CONFIRMATION");
  const bPass =
    bDraft?.action === "clarification_sent" &&
    (bOrders ?? []).length === 0 &&
    typeof bDraft?.message === "string" &&
    bDraft.message.length > 0;
  record("Case b: non-catalog → clarification, NO order", bPass,
    `draft=${JSON.stringify(bDraft)}\npendingOrders=${(bOrders ?? []).length}`);

  // ========== Stock shortage ==========
  await cleanBuyerState(business.id);
  const originalStock = mugVariant?.stock_quantity ?? 25;
  await admin
    .from("product_variants")
    .update({ stock_quantity: 1, reserved_quantity: 0, track_inventory: true })
    .eq("id", mugVariant.id);
  try {
    const sSend = await sendWhatsApp("I'd like 2 of the blue mug");
    await sleep(2500);
    const sDraft = sSend.json.draft;
    const { data: sOrders } = await admin
      .from("orders")
      .select("id")
      .eq("business_id", business.id)
      .eq("status", "PENDING_CONFIRMATION");
    const sPass =
      sDraft?.action === "stock_shortage" &&
      (sOrders ?? []).length === 0 &&
      /stock|left|out of stock/i.test(sDraft?.message ?? "");
    record("Stock case: insufficient stock → shortage message, NO order", sPass,
      `draft=${JSON.stringify(sDraft)}\npendingOrders=${(sOrders ?? []).length}`);
  } finally {
    await admin
      .from("product_variants")
      .update({ stock_quantity: originalStock })
      .eq("id", mugVariant.id);
  }

  // Recent outbound messages to buyer for the report
  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", BUYER)
    .maybeSingle();
  const { data: outbound } = await admin
    .from("messages")
    .select("id, normalised_text, created_at, direction")
    .eq("customer_id", customer?.id ?? "00000000-0000-0000-0000-000000000000")
    .eq("direction", "outbound")
    .order("created_at", { ascending: true });

  console.log("\n========================================");
  console.log("Outbound WhatsApp texts persisted (check your phone):");
  console.log("========================================");
  for (const row of outbound ?? []) {
    console.log(`\n[${row.created_at}]\n${row.normalised_text}`);
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
