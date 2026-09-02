/**
 * Verifies one owner, multiple shops at the application layer:
 *   - /onboarding?add=1 is reachable while already owning a shop
 *   - creating a second shop (same path as the wizard insert)
 *   - active_business_id cookie switches dashboard data with no bleed
 *   - an unrelated user still cannot see either shop
 *   - public storefronts are unaffected by the cookie
 *
 * Requires the Next.js dev server.
 *
 *   node scripts/verify-multi-shop.mjs
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

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

const stamp = Date.now();
const OWNER_EMAIL = `multi-shop-app-${stamp}@tradeflow-test.local`;
const OWNER_PASSWORD = "MultiShopApp!123";
const OTHER_EMAIL = `multi-shop-app-other-${stamp}@tradeflow-test.local`;
const OTHER_PASSWORD = "MultiShopOther!123";
const SHOP_A = {
  name: `Cedar & Co ${stamp}`,
  slug: `cedar-co-${stamp}`,
  product: `Cedar mug ${stamp}`,
  customer: `Cedar buyer ${stamp}`,
  phone: `+44771${String(stamp).slice(-7)}`,
  orderRef: `MS${stamp}A`,
  threadPreview: `cedar inbox ${stamp}`,
};
const SHOP_B = {
  name: `Willow Works ${stamp}`,
  slug: `willow-works-${stamp}`,
  product: `Willow vase ${stamp}`,
  customer: `Willow buyer ${stamp}`,
  phone: `+44772${String(stamp).slice(-7)}`,
  orderRef: `MS${stamp}B`,
  threadPreview: `willow inbox ${stamp}`,
};

const DASHBOARD_PATHS = [
  "/dashboard/orders",
  "/dashboard/products",
  "/dashboard/settings",
  "/dashboard/inbox",
  "/dashboard/analytics",
  "/dashboard/customers",
];

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
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
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
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
  for (const header of headers) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const i = cookies.findIndex((c) => c.name === name);
    if (i >= 0) cookies[i] = { name, value };
    else cookies.push({ name, value });
  }
}

async function fetchPage(path, cookies, redirect = "manual") {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Cookie: cookieHeader(cookies) },
    redirect,
  });
  const html = await response.text();
  applySetCookie(cookies, response);
  return {
    status: response.status,
    location: response.headers.get("location"),
    html,
  };
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
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function seedShop(supabase, ownerUserId, shop) {
  const { data: business, error: bizError } = await supabase
    .from("businesses")
    .insert({
      owner_user_id: ownerUserId,
      name: shop.name,
      slug: shop.slug,
      dispatch_address_line1: "1 Test Street",
      dispatch_city: "London",
      dispatch_postcode: "E1 1AA",
    })
    .select("id")
    .single();
  if (bizError) throw bizError;

  const { data: product, error: productError } = await supabase
    .from("products")
    .insert({
      business_id: business.id,
      name: shop.product,
      price_pence: 1200,
      active: true,
    })
    .select("id")
    .single();
  if (productError) throw productError;

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .insert({
      business_id: business.id,
      name: shop.customer,
      phone_e164: shop.phone,
    })
    .select("id")
    .single();
  if (customerError) throw customerError;

  const { error: orderError } = await supabase.from("orders").insert({
    business_id: business.id,
    customer_id: customer.id,
    channel: "storefront",
    status: "PAID",
    total_pence: 1200,
    order_ref: shop.orderRef,
  });
  if (orderError) throw orderError;

  const threadId = randomUUID();
  const { error: messageError } = await supabase.from("messages").insert({
    business_id: business.id,
    customer_id: customer.id,
    channel: "whatsapp",
    direction: "inbound",
    thread_id: threadId,
    normalised_text: shop.threadPreview,
  });
  if (messageError) throw messageError;

  return { businessId: business.id, productId: product.id, customerId: customer.id, threadId };
}

async function deleteBusinesses(ids) {
  if (!ids.length) return;
  for (const table of [
    "order_items",
    "order_status_history",
    "refunds",
    "messages",
    "orders",
    "customers",
    "product_variants",
    "products",
    "broadcasts",
    "analytics_cache",
  ]) {
    await admin.from(table).delete().in("business_id", ids);
  }
  await admin.from("businesses").delete().in("id", ids);
}

async function cleanup(ownerUserId, otherUserId, businessIds) {
  await deleteBusinesses(businessIds);
  if (ownerUserId) {
    const { data: leftover } = await admin
      .from("businesses")
      .select("id")
      .eq("owner_user_id", ownerUserId);
    if (leftover?.length) {
      await deleteBusinesses(leftover.map((row) => row.id));
    }
    await admin.auth.admin.deleteUser(ownerUserId);
  }
  if (otherUserId) {
    const { data: leftover } = await admin
      .from("businesses")
      .select("id")
      .eq("owner_user_id", otherUserId);
    if (leftover?.length) {
      await deleteBusinesses(leftover.map((row) => row.id));
    }
    await admin.auth.admin.deleteUser(otherUserId);
  }
}

function has(html, value) {
  if (html.includes(value)) return true;
  const encoded = value.replace(/&/g, "&amp;");
  return encoded !== value && html.includes(encoded);
}

async function main() {
  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    console.error("Dev server not running. Start with: npm run dev");
    process.exit(1);
  }

  let ownerUserId = null;
  let otherUserId = null;
  const createdIds = [];

  try {
    ownerUserId = await ensureUser(OWNER_EMAIL, OWNER_PASSWORD);
    otherUserId = await ensureUser(OTHER_EMAIL, OTHER_PASSWORD);
    const { supabase, cookies } = await mintCookies(OWNER_EMAIL, OWNER_PASSWORD);

    const shopA = await seedShop(supabase, ownerUserId, SHOP_A);
    createdIds.push(shopA.businessId);

    const blocked = await fetchPage("/onboarding", cookies);
    record(
      "Logged-in owner of one shop is redirected away from /onboarding",
      (blocked.status === 307 || blocked.status === 308) &&
        (blocked.location ?? "").includes("/dashboard"),
      `status=${blocked.status} location=${blocked.location}`,
    );

    const addPage = await fetchPage("/onboarding?add=1", cookies);
    record(
      "Add another shop: /onboarding?add=1 is reachable and does not skip the wizard",
      addPage.status === 200 && has(addPage.html, "Add another shop"),
      `status=${addPage.status} hasHeading=${has(addPage.html, "Add another shop")}`,
    );

    const shopB = await seedShop(supabase, ownerUserId, SHOP_B);
    createdIds.push(shopB.businessId);
    record(
      "Wizard-equivalent INSERT created a second shop for the same owner",
      Boolean(shopB.businessId) && shopB.businessId !== shopA.businessId,
      `a=${shopA.businessId} b=${shopB.businessId}`,
    );

    const { data: owned } = await supabase
      .from("businesses")
      .select("id, slug")
      .eq("owner_user_id", ownerUserId)
      .is("deleted_at", null);
    record(
      "RLS lets the owner SELECT both shops",
      (owned ?? []).length === 2,
      `count=${owned?.length ?? 0}`,
    );

    const switchedA = await setActive(cookies, shopA.businessId);
    record(
      "POST /api/dashboard/active-business accepts shop A",
      switchedA.status === 200 && switchedA.json.businessId === shopA.businessId,
      `status=${switchedA.status} id=${switchedA.json.businessId}`,
    );

    for (const path of DASHBOARD_PATHS) {
      const page = await fetchPage(path, cookies);
      const showsA =
        has(page.html, SHOP_A.name) ||
        has(page.html, SHOP_A.product) ||
        has(page.html, SHOP_A.customer) ||
        has(page.html, SHOP_A.orderRef) ||
        has(page.html, SHOP_A.threadPreview);
      const showsB =
        has(page.html, SHOP_B.product) ||
        has(page.html, SHOP_B.customer) ||
        has(page.html, SHOP_B.orderRef) ||
        has(page.html, SHOP_B.threadPreview);
      const settingsOk =
        path !== "/dashboard/settings" ||
        (has(page.html, SHOP_A.slug) && !has(page.html, SHOP_B.slug));
      record(
        `Active shop A: ${path} shows A data and not B`,
        page.status === 200 && showsA && !showsB && settingsOk,
        `status=${page.status} showsA=${showsA} showsB=${showsB}`,
      );
    }

    const switchedB = await setActive(cookies, shopB.businessId);
    record(
      "POST /api/dashboard/active-business switches to shop B",
      switchedB.status === 200 && switchedB.json.businessId === shopB.businessId,
      `status=${switchedB.status} id=${switchedB.json.businessId}`,
    );

    for (const path of DASHBOARD_PATHS) {
      const page = await fetchPage(path, cookies);
      const showsB =
        has(page.html, SHOP_B.name) ||
        has(page.html, SHOP_B.product) ||
        has(page.html, SHOP_B.customer) ||
        has(page.html, SHOP_B.orderRef) ||
        has(page.html, SHOP_B.threadPreview);
      const showsA =
        has(page.html, SHOP_A.product) ||
        has(page.html, SHOP_A.customer) ||
        has(page.html, SHOP_A.orderRef) ||
        has(page.html, SHOP_A.threadPreview);
      const settingsOk =
        path !== "/dashboard/settings" ||
        (has(page.html, SHOP_B.slug) && !has(page.html, SHOP_A.slug));
      record(
        `Active shop B: ${path} shows B data and not A`,
        page.status === 200 && showsB && !showsA && settingsOk,
        `status=${page.status} showsB=${showsB} showsA=${showsA}`,
      );
    }

    const stale = await setActive(cookies, randomUUID());
    record(
      "Stale/foreign active_business_id is rejected (cookie is not a security boundary, but we do not honour it)",
      stale.status === 403,
      `status=${stale.status}`,
    );

    const { cookies: otherCookies } = await mintCookies(OTHER_EMAIL, OTHER_PASSWORD);
    const otherDash = await fetchPage("/dashboard/orders", otherCookies);
    record(
      "Unrelated user is not shown either shop (redirected to onboarding or empty of A/B data)",
      !has(otherDash.html, SHOP_A.name) &&
        !has(otherDash.html, SHOP_B.name) &&
        !has(otherDash.html, SHOP_A.product) &&
        !has(otherDash.html, SHOP_B.product),
      `status=${otherDash.status} location=${otherDash.location}`,
    );

    const otherSwitch = await setActive(otherCookies, shopA.businessId);
    record(
      "Unrelated user cannot set active_business_id to someone else's shop",
      otherSwitch.status === 403 || otherSwitch.status === 401,
      `status=${otherSwitch.status}`,
    );

    const storeA = await fetch(`${BASE}/s/${SHOP_A.slug}`);
    const storeAHtml = await storeA.text();
    const storeB = await fetch(`${BASE}/s/${SHOP_B.slug}`);
    const storeBHtml = await storeB.text();
    record(
      "Public storefront A is unaffected and shows only A's shop (catalog may be gated on billing)",
      storeA.status === 200 &&
        has(storeAHtml, SHOP_A.name) &&
        !has(storeAHtml, SHOP_B.name) &&
        !has(storeAHtml, SHOP_B.product),
      `status=${storeA.status} hasName=${has(storeAHtml, SHOP_A.name)} leakedB=${has(storeAHtml, SHOP_B.name) || has(storeAHtml, SHOP_B.product)}`,
    );
    record(
      "Public storefront B is unaffected and shows only B's shop (catalog may be gated on billing)",
      storeB.status === 200 &&
        has(storeBHtml, SHOP_B.name) &&
        !has(storeBHtml, SHOP_A.name) &&
        !has(storeBHtml, SHOP_A.product),
      `status=${storeB.status} hasName=${has(storeBHtml, SHOP_B.name)} leakedA=${has(storeBHtml, SHOP_A.name) || has(storeBHtml, SHOP_A.product)}`,
    );
  } finally {
    await cleanup(ownerUserId, otherUserId, createdIds);
  }

  const passed = results.every((r) => r.passed);
  console.log("\n========================================");
  console.log(passed ? "MULTI-SHOP APP: PASSED" : "MULTI-SHOP APP: FAILED");
  console.log("========================================");
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
