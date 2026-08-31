/**
 * Verifies the public /s/[slug] storefront:
 *   1. Unauthenticated catalog for EK-Pousser_D (no sensitive fields in HTML/RSC)
 *   2. wa.me Order via WhatsApp links encode a well-formed product/variant message
 *   3. That exact message matches via the live order_parse pipeline
 *   4. Unknown slug is a clean not-found (not a crash)
 *   5. Deactivating a product removes it from the public catalog immediately
 *   6. Dashboard settings shows the shareable storefront URL
 *
 * Also asserts anon RLS still cannot read businesses/products.
 *
 * Run (dev server or production):
 *   node scripts/verify-storefront.mjs
 *   BASE_URL=https://tradeflow-tau-blush.vercel.app node scripts/verify-storefront.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447700900092";
const EK_EMAIL = "sgkiket@gmail.com";
const SENSITIVE_FIELD_NAMES = [
  "stripe_connected_account_id",
  "stripe_charges_enabled",
  "stripe_payouts_enabled",
  "stripe_details_submitted",
  "dispatch_address_line1",
  "dispatch_city",
  "dispatch_postcode",
  "owner_user_id",
  "payout_account",
  "payout_sort_code",
  "payout_account_number",
  "whatsapp_waba_id",
  "seller_whatsapp_phone_e164",
  "whatsapp_phone_e164",
];

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
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonClient = createClient(url, anon, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(webhookUrl, params) {
  const sorted = Object.keys(params).sort();
  let data = webhookUrl;
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
    ProfileName: "Storefront Verifier",
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
      .select("id, normalised_text, ai_parse_result")
      .eq("id", messageId)
      .maybeSingle();
    if (data?.ai_parse_result) return data;
    await new Promise((r) => setTimeout(r, 500));
  }
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text, ai_parse_result")
    .eq("id", messageId)
    .maybeSingle();
  return data;
}

async function fetchPublic(path, extraHeaders = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      ...extraHeaders,
    },
    redirect: "manual",
    cache: "no-store",
  });
  const body = await response.text();
  return { status: response.status, body, contentType: response.headers.get("content-type") };
}

async function fetchRsc(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      RSC: "1",
      Accept: "text/x-component",
    },
    redirect: "manual",
    cache: "no-store",
  });
  const body = await response.text();
  return { status: response.status, body };
}

function extractNextFlight(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[.*?\]\)/g;
  let match;
  while ((match = re.exec(html))) {
    chunks.push(match[0]);
  }
  return chunks.join("\n");
}

function leakedSensitive(payload, extraForbidden = []) {
  const haystack = payload.toLowerCase();
  const hits = [];
  for (const field of SENSITIVE_FIELD_NAMES) {
    if (haystack.includes(field.toLowerCase())) hits.push(field);
  }
  for (const value of extraForbidden) {
    if (value && payload.includes(value)) hits.push(value);
  }
  return hits;
}

async function mintEkCookies() {
  const cookies = [];
  const supabase = createBrowserClient(url, anon, {
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
    email: EK_EMAIL,
  });
  if (linkError) throw linkError;
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError) throw otpError;
  return cookies;
}

async function cleanBuyer(businessId) {
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", BUYER);
  const ids = (customers ?? []).map((c) => c.id);
  if (!ids.length) return;
  await admin.from("messages").delete().in("customer_id", ids);
  await admin.from("customers").delete().in("id", ids);
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function extractWaMeHrefs(html) {
  const raw = [...html.matchAll(/https:\/\/wa\.me\/[^"'\\\s]+/g)].map((m) =>
    decodeHtmlEntities(m[0]),
  );
  return [...new Set(raw)];
}

function decodeWaMeText(href) {
  try {
    return new URL(href).searchParams.get("text") ?? "";
  } catch {
    return "";
  }
}

async function main() {
  const { data: business, error } = await admin
    .from("businesses")
    .select(
      "id, slug, name, owner_user_id, stripe_connected_account_id, dispatch_address_line1, whatsapp_phone_e164",
    )
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!business) throw new Error("EK-Pousser_D not found");
  if (!business.slug) throw new Error("EK-Pousser_D has no slug");

  const { data: catalog } = await admin
    .from("products")
    .select("id, name, active, product_variants(id, label, deleted_at)")
    .eq("business_id", business.id)
    .eq("active", true)
    .is("deleted_at", null);

  const activeProducts = catalog ?? [];
  const mug = activeProducts.find((p) => /blue mug/i.test(p.name));
  const mugVariant = (mug?.product_variants ?? []).find((v) => !v.deleted_at);
  const expectedMessage = mugVariant?.label
    ? `Hi! I'd like to order the ${mug.name} (${mugVariant.label})`
    : `Hi! I'd like to order the ${mug?.name ?? "Classic Blue Mug"}`;

  const forbiddenIds = [
    business.owner_user_id,
    business.stripe_connected_account_id,
    ...(activeProducts.map((p) => p.id)),
  ].filter(Boolean);

  console.log(`BASE ${BASE}`);
  console.log(`Business: ${business.name} slug=${business.slug} id=${business.id}`);
  console.log(`Active products: ${activeProducts.map((p) => p.name).join(", ")}`);
  console.log(`Expected order message: ${expectedMessage}\n`);

  const { data: anonBiz } = await anonClient
    .from("businesses")
    .select("id, name, slug, stripe_connected_account_id, dispatch_address_line1")
    .eq("slug", business.slug)
    .maybeSingle();
  const { data: anonProducts } = await anonClient
    .from("products")
    .select("id, name")
    .eq("business_id", business.id);
  record(
    "RLS: anon still cannot read businesses/products by slug",
    !anonBiz && !(anonProducts && anonProducts.length),
    `anonBiz=${JSON.stringify(anonBiz)} anonProducts=${JSON.stringify(anonProducts)}`,
  );

  const page = await fetchPublic(`/s/${business.slug}`);
  const rsc = await fetchRsc(`/s/${business.slug}`);
  const flight = extractNextFlight(page.body);
  const combined = `${page.body}\n${flight}\n${rsc.body}`;
  const leaks = leakedSensitive(combined, forbiddenIds);
  const waLinks = extractWaMeHrefs(`${page.body}\n${rsc.body}`);
  const mugLink = waLinks.find((href) =>
    decodeURIComponent(href).toLowerCase().includes("classic blue mug"),
  );
  const mugText = mugLink ? decodeWaMeText(mugLink) : "";
  const catalogVisible =
    page.status === 200 &&
    page.body.includes(business.name) &&
    activeProducts.every((p) => page.body.includes(p.name));
  record(
    "1. Unauthenticated /s/{slug} shows active catalog with no sensitive payload fields",
    catalogVisible && leaks.length === 0,
    `status=${page.status} rscStatus=${rsc.status} leaks=${JSON.stringify(leaks)} products=${activeProducts.map((p) => p.name).join("|")} payloadChars=${combined.length}`,
  );
  console.log("       Public HTML product names present:", catalogVisible);
  console.log("       wa.me link count:", waLinks.length);
  if (mugLink) {
    console.log("       Mug wa.me:", mugLink);
    console.log("       Mug prefill:", mugText);
  }

  const waPass =
    Boolean(mugLink) &&
    mugText === expectedMessage &&
    /wa\.me\/\d+\?text=/.test(mugLink);
  record(
    "2. Order via WhatsApp builds a correctly encoded wa.me link for the mug",
    waPass,
    `href=${mugLink ?? "MISSING"} text=${JSON.stringify(mugText)}`,
  );

  await cleanBuyer(business.id);
  try {
    const inbound = await sendWhatsApp(mugText || expectedMessage);
    const parsed = await waitForParse(inbound.json.messageId);
    const result = parsed?.ai_parse_result;
    const item = result?.items?.[0];
    const parsePass =
      inbound.status === 200 &&
      inbound.json.parseStored === true &&
      result?.intent === "order" &&
      item?.matched_product_id === mug?.id &&
      (mugVariant ? item?.matched_variant_id === mugVariant.id : true) &&
      (item?.quantity ?? 0) === 1 &&
      (item?.match_confidence ?? 0) >= 0.6 &&
      result?.needs_clarification !== true;
    record(
      "3. Exact storefront prefill matches via live order_parse pipeline",
      parsePass,
      JSON.stringify(
        {
          status: inbound.status,
          parseStored: inbound.json.parseStored,
          parse: result,
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanBuyer(business.id);
  }

  const missing = await fetchPublic("/s/this-slug-does-not-exist-tf");
  const missingOk =
    missing.status === 404 &&
    /store not found/i.test(missing.body) &&
    !/application error/i.test(missing.body) &&
    !/internal server error/i.test(missing.body);
  record(
    "4. Unknown slug is a clean not-found state",
    missingOk,
    `status=${missing.status} snippet=${missing.body.replace(/\s+/g, " ").slice(0, 180)}`,
  );

  const hideTarget =
    activeProducts.find((p) => !/blue mug/i.test(p.name)) ?? activeProducts[0];
  if (!hideTarget) {
    record("5. Deactivated product disappears from public storefront", false, "no product to hide");
  } else {
    const originalActive = hideTarget.active;
    try {
      const { error: hideError } = await admin
        .from("products")
        .update({ active: false })
        .eq("id", hideTarget.id);
      if (hideError) throw hideError;
      const afterHide = await fetchPublic(`/s/${business.slug}`);
      const gone =
        afterHide.status === 200 &&
        !afterHide.body.includes(hideTarget.name) &&
        (mug ? afterHide.body.includes(mug.name) : true);
      record(
        "5. Deactivated product disappears from public storefront immediately",
        gone,
        `hid=${hideTarget.name} status=${afterHide.status} stillPresent=${afterHide.body.includes(hideTarget.name)}`,
      );
    } finally {
      await admin
        .from("products")
        .update({ active: originalActive })
        .eq("id", hideTarget.id);
    }
  }

  const cookies = await mintEkCookies();
  const settings = await fetch(`${BASE}/dashboard/settings`, {
    headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    redirect: "manual",
    cache: "no-store",
  });
  const settingsHtml = await settings.text();
  const expectedUrl = `https://tradeflow-tau-blush.vercel.app/s/${business.slug}`;
  const settingsPass =
    settings.status === 200 &&
    settingsHtml.includes("Storefront") &&
    settingsHtml.includes(expectedUrl);
  record(
    "6. Dashboard settings shows the public storefront URL",
    settingsPass,
    `status=${settings.status} expected=${expectedUrl}`,
  );

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
