/**
 * Verifies CSV catalog import: template, preview, fail-closed validation,
 * create-only duplicates, conflicting fields, storefront + order_parse, and
 * cross-tenant isolation.
 *
 * Requires the Next.js dev server.
 *
 *   node scripts/verify-csv-import.mjs
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
const BUYER = "+447700900093";
const EK_EMAIL = "sgkiket@gmail.com";

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
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;

const stamp = Date.now();
const CANDLE = `CSV Birch Candle ${stamp}`;
const SNEAKER = `CSV Oak Sneaker ${stamp}`;
const JACKET = `CSV Pine Jacket ${stamp}`;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function header() {
  return "product_name,description,price_gbp,photo_url,active,variant_label,stock_quantity,low_stock_threshold,weight_grams";
}

function validCsv() {
  return [
    header(),
    `${CANDLE},"Soy candle in a tin.",14.00,,yes,,10,5,300`,
    `${SNEAKER},"Canvas sneaker.",42.00,,yes,Size 9,4,5,800`,
    `${SNEAKER},"Canvas sneaker.",42.00,,yes,Size 10,6,5,800`,
    `${JACKET},"Waxed cotton jacket.",89.00,,yes,Small,2,5,900`,
    `${JACKET},"Waxed cotton jacket.",89.00,,yes,Medium,3,5,900`,
    `${JACKET},"Waxed cotton jacket.",89.00,,yes,Large,1,5,900`,
  ].join("\n");
}

async function mintCookies(email, password) {
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
  if (password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  } else {
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
  }
  return { supabase, cookies };
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function applySetCookie(cookies, response) {
  const headers =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const headerLine of headers) {
    const pair = headerLine.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const i = cookies.findIndex((c) => c.name === name);
    if (i >= 0) cookies[i] = { name, value };
    else cookies.push({ name, value });
  }
}

async function setActive(cookies, businessId) {
  const response = await fetch(`${BASE}/api/dashboard/active-business`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(cookies),
    },
    body: JSON.stringify({ businessId }),
  });
  applySetCookie(cookies, response);
  return response.ok;
}

async function importApi(cookies, csv, confirm) {
  const response = await fetch(`${BASE}/api/dashboard/products/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(cookies),
    },
    body: JSON.stringify({ csv, confirm }),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function ensureUser(email, password) {
  const { data: listed } = await admin.auth.admin.listUsers();
  const existing = listed?.users?.find((u) => u.email === email);
  if (existing) {
    await admin.auth.admin.updateUserById(existing.id, { password });
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

async function deleteProducts(ids) {
  if (!ids.length) return;
  await admin.from("product_images").delete().in("product_id", ids);
  await admin.from("product_variants").delete().in("product_id", ids);
  await admin.from("products").delete().in("id", ids);
}

async function deleteBusinesses(ids) {
  if (!ids.length) return;
  await admin.from("product_images").delete().in("business_id", ids);
  await admin.from("product_variants").delete().in("business_id", ids);
  await admin.from("products").delete().in("business_id", ids);
  await admin.from("businesses").delete().in("id", ids);
}

function signTwilio(webhookUrl, params) {
  const sorted = Object.keys(params).sort();
  let data = webhookUrl;
  for (const key of sorted) data += key + params[key];
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
    ProfileName: "CSV Import Tester",
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

async function waitForParse(messageId, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    const { data } = await admin
      .from("messages")
      .select("id, ai_parse_result")
      .eq("id", messageId)
      .maybeSingle();
    if (data?.ai_parse_result) return data;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    console.error("Dev server not running. Start with: npm run dev");
    process.exit(1);
  }

  const { data: ek } = await admin
    .from("businesses")
    .select("id, slug, name")
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  if (!ek) throw new Error("EK-Pousser_D not found");

  const createdIds = [];
  const tenantIds = [];
  let tenantUserA = null;
  let tenantUserB = null;

  try {
    const { cookies } = await mintCookies(EK_EMAIL);
    await setActive(cookies, ek.id);

    const template = await fetch(`${BASE}/api/dashboard/products/import`, {
      headers: { Cookie: cookieHeader(cookies) },
    });
    const templateText = await template.text();
    record(
      "1a. Template downloads with TradeFlow columns and example single + multi-variant rows",
      template.status === 200 &&
        templateText.includes("product_name") &&
        templateText.includes("price_gbp") &&
        templateText.includes("Example Soap Bar") &&
        templateText.includes("Example Tote Bag") &&
        templateText.includes("Natural") &&
        templateText.includes("Navy"),
      `status=${template.status} bytes=${templateText.length}`,
    );

    const csv = validCsv();
    const preview = await importApi(cookies, csv, false);
    const previewOk =
      preview.status === 200 &&
      preview.json.valid === true &&
      preview.json.productCount === 3 &&
      preview.json.variantCount === 6 &&
      preview.json.rowCount === 6;
    record(
      "1b. Preview of 3 products / 6 variants (1+2+3) is valid with those counts",
      previewOk,
      `status=${preview.status} products=${preview.json.productCount} variants=${preview.json.variantCount} rows=${preview.json.rowCount} errors=${preview.json.errors?.length ?? 0}`,
    );

    const confirmed = await importApi(cookies, csv, true);
    if (Array.isArray(confirmed.json.productIds)) {
      createdIds.push(...confirmed.json.productIds);
    }
    record(
      "1c. Confirm import creates exactly 3 products and 6 variants",
      confirmed.status === 200 &&
        confirmed.json.created === true &&
        confirmed.json.productCount === 3 &&
        confirmed.json.variantCount === 6 &&
        (confirmed.json.productIds?.length ?? 0) === 3,
      `status=${confirmed.status} created=${confirmed.json.created} ids=${(confirmed.json.productIds ?? []).join(",")}`,
    );

    const { data: dbProducts } = await admin
      .from("products")
      .select("id, name, product_variants(id, label, deleted_at)")
      .in("id", createdIds);
    const variantCounts = (dbProducts ?? []).map((row) => ({
      name: row.name,
      variants: (row.product_variants ?? []).filter((v) => !v.deleted_at).length,
    }));
    const dbOk =
      variantCounts.length === 3 &&
      variantCounts.some((row) => row.name === CANDLE && row.variants === 1) &&
      variantCounts.some((row) => row.name === SNEAKER && row.variants === 2) &&
      variantCounts.some((row) => row.name === JACKET && row.variants === 3);
    record(
      "1d. Database has the candle (1), sneaker (2) and jacket (3) variants",
      dbOk,
      JSON.stringify(variantCounts),
    );

    const store = await fetch(`${BASE}/s/${ek.slug}`, { cache: "no-store" });
    const storeHtml = await store.text();
    record(
      "2. Newly imported candle appears on the live public storefront",
      store.status === 200 && storeHtml.includes(CANDLE),
      `status=${store.status} hasCandle=${storeHtml.includes(CANDLE)}`,
    );

    const inbound = await sendWhatsApp(`Hi, I'd like one ${CANDLE}`);
    const parsed = inbound.json.messageId
      ? await waitForParse(inbound.json.messageId)
      : null;
    const parse = parsed?.ai_parse_result;
    const item = parse?.items?.[0];
    const candleRow = (dbProducts ?? []).find((row) => row.name === CANDLE);
    const matched =
      inbound.status === 200 &&
      inbound.json.parseStored === true &&
      parse?.intent === "order" &&
      item?.matched_product_id === candleRow?.id &&
      (item?.match_confidence ?? 0) >= 0.6;
    record(
      "3. order_parse matches the imported candle (same pipeline as form-created products)",
      matched,
      JSON.stringify({
        status: inbound.status,
        parseStored: inbound.json.parseStored,
        intent: parse?.intent,
        matched_product_id: item?.matched_product_id,
        expected: candleRow?.id,
        confidence: item?.match_confidence,
      }),
    );

    const missingPrice = [
      header(),
      `${CANDLE} Extra,"Has a price.",9.00,,yes,,1,5,200`,
      `Broken Row ${stamp},"Missing price.",,,yes,,1,5,200`,
    ].join("\n");
    const beforeCount = (
      await admin
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("business_id", ek.id)
        .is("deleted_at", null)
    ).count;
    const blocked = await importApi(cookies, missingPrice, true);
    const afterCount = (
      await admin
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("business_id", ek.id)
        .is("deleted_at", null)
    ).count;
    const missingErr = (blocked.json.errors ?? []).find(
      (e) => e.field === "price_gbp" && e.row === 3,
    );
    record(
      "4. Missing price_gbp blocks the whole import and creates nothing",
      blocked.status === 400 &&
        blocked.json.valid === false &&
        Boolean(missingErr) &&
        beforeCount === afterCount,
      `status=${blocked.status} error=${missingErr?.message} countBefore=${beforeCount} after=${afterCount}`,
    );

    const duplicate = [
      header(),
      `Classic Blue Mug,"Should not import.",12.00,,yes,,1,5,200`,
      `${CANDLE} Two,"Also blocked because of the duplicate.",8.00,,yes,,1,5,200`,
    ].join("\n");
    const dupPreview = await importApi(cookies, duplicate, false);
    const dupConfirm = await importApi(cookies, duplicate, true);
    const dupErr = (dupPreview.json.errors ?? []).find((e) =>
      /already exists/i.test(e.message),
    );
    const confirmHasButtonBlocked =
      dupConfirm.status === 400 && dupConfirm.json.valid === false;
    record(
      "5. Existing catalog name is a duplicate and fail-closes the whole file",
      dupPreview.json.valid === false &&
        Boolean(dupErr) &&
        confirmHasButtonBlocked &&
        !(dupConfirm.json.productIds ?? []).length,
      `previewValid=${dupPreview.json.valid} dup=${dupErr?.message} confirm=${dupConfirm.status}`,
    );

    const conflict = [
      header(),
      `${CANDLE} Conflict,"Same product, two prices.",10.00,,yes,Red,1,5,200`,
      `${CANDLE} Conflict,"Same product, two prices.",12.00,,yes,Blue,1,5,200`,
    ].join("\n");
    const conflictPreview = await importApi(cookies, conflict, false);
    const conflictErr = (conflictPreview.json.errors ?? []).find((e) =>
      /conflicting prices/i.test(e.message),
    );
    record(
      "6. Same product_name with different prices is a conflicting-fields error",
      conflictPreview.json.valid === false && Boolean(conflictErr),
      conflictErr?.message ?? JSON.stringify(conflictPreview.json.errors),
    );

    const emailA = `csv-import-a-${stamp}@tradeflow-test.local`;
    const emailB = `csv-import-b-${stamp}@tradeflow-test.local`;
    tenantUserA = await ensureUser(emailA, "CsvImportA!123");
    tenantUserB = await ensureUser(emailB, "CsvImportB!123");
    const { data: bizA, error: bizAError } = await admin
      .from("businesses")
      .insert({
        owner_user_id: tenantUserA,
        slug: `csv-imp-a-${stamp}`,
        name: "CSV Import Tenant A",
      })
      .select("id")
      .single();
    const { data: bizB, error: bizBError } = await admin
      .from("businesses")
      .insert({
        owner_user_id: tenantUserB,
        slug: `csv-imp-b-${stamp}`,
        name: "CSV Import Tenant B",
      })
      .select("id")
      .single();
    if (bizAError || bizBError) throw bizAError || bizBError;
    tenantIds.push(bizA.id, bizB.id);

    await admin.from("products").insert({
      business_id: bizB.id,
      name: "Shared Catalog Name",
      price_pence: 500,
      active: true,
    });

    const { cookies: cookiesA } = await mintCookies(emailA, "CsvImportA!123");
    await setActive(cookiesA, bizA.id);
    const sharedCsv = [
      header(),
      `Shared Catalog Name,"Tenant A copy.",7.00,,yes,,3,5,200`,
    ].join("\n");
    const sharedPreview = await importApi(cookiesA, sharedCsv, false);
    const sharedConfirm = await importApi(cookiesA, sharedCsv, true);
    if (Array.isArray(sharedConfirm.json.productIds)) {
      createdIds.push(...sharedConfirm.json.productIds);
    }
    const { data: aProducts } = await admin
      .from("products")
      .select("id, name, business_id")
      .eq("business_id", bizA.id)
      .is("deleted_at", null);
    const { data: bProducts } = await admin
      .from("products")
      .select("id, name, business_id")
      .eq("business_id", bizB.id)
      .is("deleted_at", null);
    const aOnly = (aProducts ?? []).every((row) => row.business_id === bizA.id);
    const bUnchanged =
      (bProducts ?? []).length === 1 &&
      bProducts[0].name === "Shared Catalog Name";
    record(
      "7. Duplicate check is per-shop; tenant A can import a name tenant B already has, and rows stay on A",
      sharedPreview.json.valid === true &&
        sharedConfirm.status === 200 &&
        aOnly &&
        (aProducts ?? []).length === 1 &&
        bUnchanged,
      `previewValid=${sharedPreview.json.valid} aCount=${aProducts?.length} bCount=${bProducts?.length} bName=${bProducts?.[0]?.name}`,
    );
  } finally {
    await deleteProducts(createdIds);
    await deleteBusinesses(tenantIds);
    if (tenantUserA) await admin.auth.admin.deleteUser(tenantUserA);
    if (tenantUserB) await admin.auth.admin.deleteUser(tenantUserB);
    const { data: customers } = await admin
      .from("customers")
      .select("id")
      .eq("phone_e164", BUYER);
    const customerIds = (customers ?? []).map((row) => row.id);
    if (customerIds.length) {
      await admin.from("messages").delete().in("customer_id", customerIds);
    }
  }

  const passed = results.every((r) => r.passed);
  console.log("\n========================================");
  console.log(passed ? "CSV IMPORT: PASSED" : "CSV IMPORT: FAILED");
  console.log("========================================");
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
