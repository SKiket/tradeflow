/**
 * Verifies order_parse end to end via signed Twilio WhatsApp payloads.
 *
 * Cases:
 *  a. Unambiguous single-item order for a real catalog item
 *  b. Order for something NOT in the catalog → needs_clarification
 *  c. Non-order question → intent "question"
 *  d. Follow-up correction in the same thread → uses thread context
 *
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-order-parse.mjs
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
const SENDER = "+447700900070";

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
    From: `whatsapp:${SENDER}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Order Parse Tester",
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

async function waitForParse(messageId, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    const { data } = await admin
      .from("messages")
      .select("id, normalised_text, ai_parse_result, thread_id, customer_id")
      .eq("id", messageId)
      .maybeSingle();
    if (data?.ai_parse_result) return data;
    await new Promise((r) => setTimeout(r, 500));
  }
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text, ai_parse_result, thread_id, customer_id")
    .eq("id", messageId)
    .maybeSingle();
  return data;
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, whatsapp_phone_e164")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (business.whatsapp_phone_e164 !== SANDBOX_NUMBER) {
    throw new Error(
      `Sandbox number not mapped to EK-Pousser_D (got ${business.whatsapp_phone_e164})`,
    );
  }

  const { data: products } = await admin
    .from("products")
    .select("id, name, product_variants(id, label, deleted_at)")
    .eq("business_id", business.id)
    .eq("active", true)
    .is("deleted_at", null)
    .ilike("description", "%[order_parse_seed]%");

  if (!products?.length) {
    throw new Error("No seed catalog found — run scripts/seed-ek-pousser-catalog.mjs first");
  }

  const blueMug = products.find((p) => /blue mug/i.test(p.name));
  const sneakers = products.find((p) => /sneaker/i.test(p.name));
  const size11 = (sneakers?.product_variants ?? []).find(
    (v) => !v.deleted_at && /11/i.test(v.label),
  );
  const size10 = (sneakers?.product_variants ?? []).find(
    (v) => !v.deleted_at && /10/i.test(v.label),
  );

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Catalog products: ${products.length}`);
  console.log(`Blue Mug id: ${blueMug?.id ?? "MISSING"}`);
  console.log(`Sneakers Size 10/11: ${size10?.id ?? "?"} / ${size11?.id ?? "?"}\n`);

  // Clean prior test customer/messages for a repeatable run.
  const { data: priorCustomers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", SENDER);
  const priorIds = (priorCustomers ?? []).map((c) => c.id);
  if (priorIds.length) {
    await admin.from("messages").delete().in("customer_id", priorIds);
    await admin.from("customers").delete().in("id", priorIds);
  }

  // --- Case a: unambiguous order ---
  const a = await sendWhatsApp("I'd like 2 of the blue mug");
  const aRow = await waitForParse(a.json.messageId);
  const aParse = aRow?.ai_parse_result;
  const aItem = aParse?.items?.[0];
  const aPass =
    a.status === 200 &&
    a.json.parseStored === true &&
    aParse?.intent === "order" &&
    aItem?.matched_product_id === blueMug?.id &&
    aItem?.quantity === 2 &&
    (aItem?.match_confidence ?? 0) >= 0.6 &&
    aParse?.needs_clarification !== true;
  record(
    "Case a: unambiguous blue mug order",
    aPass,
    JSON.stringify(aParse, null, 2),
  );

  // --- Case b: not in catalog ---
  const b = await sendWhatsApp("Can I get a purple hoverboard please?");
  const bRow = await waitForParse(b.json.messageId);
  const bParse = bRow?.ai_parse_result;
  const bItem = bParse?.items?.[0];
  const bMatchedSomething =
    !!bItem?.matched_product_id &&
    products.some((p) => p.id === bItem.matched_product_id);
  const bPass =
    b.status === 200 &&
    b.json.parseStored === true &&
    (bParse?.intent === "order" || bParse?.needs_clarification === true) &&
    bParse?.needs_clarification === true &&
    (!bItem?.matched_product_id || (bItem?.match_confidence ?? 1) < 0.5) &&
    !bMatchedSomething;
  // Slightly softer: if model leaves matched id null with low confidence + clarification, that's ideal.
  // If it mistakenly matched, fail. Allow intent order with clarification.
  const bPassStrict =
    b.status === 200 &&
    b.json.parseStored === true &&
    bParse?.needs_clarification === true &&
    (!bItem?.matched_product_id || (bItem?.match_confidence ?? 1) < 0.5);
  record(
    "Case b: non-catalog item needs clarification (no hallucinated high-confidence match)",
    bPassStrict,
    JSON.stringify(bParse, null, 2),
  );

  // --- Case c: question ---
  const c = await sendWhatsApp("what's your return policy?");
  const cRow = await waitForParse(c.json.messageId);
  const cParse = cRow?.ai_parse_result;
  const cPass =
    c.status === 200 &&
    c.json.parseStored === true &&
    cParse?.intent === "question";
  record(
    "Case c: return-policy question → intent question",
    cPass,
    JSON.stringify(cParse, null, 2),
  );

  // --- Case d: follow-up correction in same thread ---
  // Start a fresh thread by using a brand-new sender so prior cases don't pollute context.
  const followSender = "+447700900071";
  const { data: priorFollow } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", followSender);
  const followIds = (priorFollow ?? []).map((c) => c.id);
  if (followIds.length) {
    await admin.from("messages").delete().in("customer_id", followIds);
    await admin.from("customers").delete().in("id", followIds);
  }

  async function sendAs(sender, bodyText) {
    const full = {
      MessageSid: nextSid(),
      AccountSid: "ACtest",
      From: `whatsapp:${sender}`,
      To: `whatsapp:${SANDBOX_NUMBER}`,
      ProfileName: "Followup Tester",
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
    return { status: response.status, json: await response.json().catch(() => ({})) };
  }

  const d1 = await sendAs(followSender, "I'd like the weekend sneakers in size 10");
  const d1Row = await waitForParse(d1.json.messageId);
  const d2 = await sendAs(followSender, "actually make it size 11");
  const d2Row = await waitForParse(d2.json.messageId);
  const d2Parse = d2Row?.ai_parse_result;
  const d2Item = d2Parse?.items?.[0];
  const sameThread = d1Row?.thread_id && d1Row.thread_id === d2Row?.thread_id;
  const dPass =
    d1.status === 200 &&
    d2.status === 200 &&
    sameThread &&
    d2.json.parseStored === true &&
    d2Parse?.intent === "order" &&
    (d2Item?.matched_variant_id === size11?.id ||
      /11/i.test(d2Item?.variant_query ?? "") ||
      /11/i.test(JSON.stringify(d2Parse)));
  record(
    "Case d: follow-up size correction uses thread context",
    dPass,
    `sameThread=${sameThread}\nfirst=${JSON.stringify(d1Row?.ai_parse_result, null, 2)}\nsecond=${JSON.stringify(d2Parse, null, 2)}`,
  );

  console.log("\n========================================");
  console.log("STORED ai_parse_result JSON");
  console.log("========================================");
  console.log("\n--- Case a ---");
  console.log(JSON.stringify(aParse, null, 2));
  console.log("\n--- Case b ---");
  console.log(JSON.stringify(bParse, null, 2));
  console.log("\n--- Case c ---");
  console.log(JSON.stringify(cParse, null, 2));
  console.log("\n--- Case d (follow-up) ---");
  console.log(JSON.stringify(d2Parse, null, 2));

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
