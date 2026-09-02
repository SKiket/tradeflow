/**
 * Verifies the live dashboard setup checklist:
 *   1. A fresh shop shows all actionable items incomplete
 *   2. Completing each item updates the checklist on the next dashboard load
 *   3. Incomplete items link to the place that resolves them
 *   4. The checklist disappears once the four real items are done
 *      (WhatsApp pending does not block completion)
 *   5. EK-Pousser_D (already live) does not show the checklist
 *   6. Two shops owned by one seller each reflect their own state
 *
 * Requires the Next.js dev server.
 *
 *   node scripts/verify-setup-checklist.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
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

const stamp = Date.now();
const OWNER_EMAIL = `setup-check-${stamp}@tradeflow-test.local`;
const OWNER_PASSWORD = "SetupCheck!123";
const FRESH_SLUG = `setup-fresh-${stamp}`;
const DONE_SLUG = `setup-done-${stamp}`;

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
    cache: "no-store",
  });
  applySetCookie(cookies, response);
  return response.status;
}

async function fetchDashboard(cookies) {
  const response = await fetch(`${BASE}/dashboard/orders`, {
    headers: { Cookie: cookieHeader(cookies), Accept: "text/html" },
    redirect: "manual",
    cache: "no-store",
  });
  const html = await response.text();
  applySetCookie(cookies, response);
  return { status: response.status, html };
}

function itemState(html, id) {
  const re = new RegExp(
    `data-setup-item="${id}"[^>]*data-setup-state="([^"]+)"|data-setup-state="([^"]+)"[^>]*data-setup-item="${id}"`,
  );
  const match = re.exec(html);
  return match?.[1] ?? match?.[2] ?? null;
}

function checklistPresent(html) {
  return html.includes("data-setup-checklist");
}

function itemBlock(html, id) {
  const marker = `data-setup-item="${id}"`;
  const start = html.indexOf(marker);
  if (start === -1) return "";
  const liStart = html.lastIndexOf("<li", start);
  const liEnd = html.indexOf("</li>", start);
  if (liStart === -1 || liEnd === -1) return "";
  return html.slice(liStart, liEnd + 5);
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
    "product_images",
    "product_variants",
    "products",
    "broadcasts",
    "analytics_cache",
  ]) {
    await admin.from(table).delete().in("business_id", ids);
  }
  await admin.from("businesses").delete().in("id", ids);
}

async function main() {
  console.log(`BASE ${BASE}\n`);
  const ownerUserId = await ensureUser(OWNER_EMAIL, OWNER_PASSWORD);
  const createdIds = [];

  try {
    const { data: fresh, error: freshError } = await admin
      .from("businesses")
      .insert({
        owner_user_id: ownerUserId,
        name: `Setup Fresh ${stamp}`,
        slug: FRESH_SLUG,
        dispatch_address_line1: "1 Test Street",
        dispatch_city: "London",
        dispatch_postcode: "E1 1AA",
      })
      .select("id")
      .single();
    if (freshError) throw new Error(freshError.message);
    createdIds.push(fresh.id);

    const { data: doneShop, error: doneError } = await admin
      .from("businesses")
      .insert({
        owner_user_id: ownerUserId,
        name: `Setup Done ${stamp}`,
        slug: DONE_SLUG,
        dispatch_address_line1: "2 Test Street",
        dispatch_city: "London",
        dispatch_postcode: "E1 1AA",
        stripe_charges_enabled: true,
        returns_policy_text: "Returns within 14 days if unused.",
      })
      .select("id")
      .single();
    if (doneError) throw new Error(doneError.message);
    createdIds.push(doneShop.id);

    const { data: doneProduct, error: doneProductError } = await admin
      .from("products")
      .insert({
        business_id: doneShop.id,
        name: `Done mug ${stamp}`,
        price_pence: 900,
        active: true,
      })
      .select("id")
      .single();
    if (doneProductError) throw new Error(doneProductError.message);
    const { error: doneVariantError } = await admin.from("product_variants").insert({
      product_id: doneProduct.id,
      business_id: doneShop.id,
      label: "Standard",
      stock_quantity: 4,
      reserved_quantity: 0,
      low_stock_threshold: 5,
      track_inventory: true,
      weight_grams: 200,
    });
    if (doneVariantError) throw new Error(doneVariantError.message);
    const { error: doneOrderError } = await admin.from("orders").insert({
      business_id: doneShop.id,
      channel: "storefront",
      status: "PAID",
      total_pence: 900,
      order_ref: `SC${stamp}D`,
    });
    if (doneOrderError) throw new Error(doneOrderError.message);

    const { supabase, cookies } = await mintCookies(OWNER_EMAIL, OWNER_PASSWORD);
    const switchFresh = await setActive(cookies, fresh.id);
    if (switchFresh !== 200) throw new Error(`Could not select fresh shop (${switchFresh})`);

    const initial = await fetchDashboard(cookies);
    const initialStates = {
      product: itemState(initial.html, "product"),
      stripe: itemState(initial.html, "stripe"),
      returns: itemState(initial.html, "returns"),
      order: itemState(initial.html, "order"),
      whatsapp: itemState(initial.html, "whatsapp"),
    };
    record(
      "1. Fresh shop shows the checklist with all real items incomplete",
      initial.status === 200 &&
        checklistPresent(initial.html) &&
        initialStates.product === "incomplete" &&
        initialStates.stripe === "incomplete" &&
        initialStates.returns === "incomplete" &&
        initialStates.order === "incomplete" &&
        initialStates.whatsapp === "pending" &&
        initial.html.includes("Connect WhatsApp (coming soon)") &&
        initial.html.includes("Pending platform rollout"),
      `status=${initial.status} ${JSON.stringify(initialStates)}`,
    );

    const productLink = initial.html.includes('href="/dashboard/products"');
    const stripeLink = initial.html.includes('href="/dashboard/settings#stripe"');
    const returnsLink = initial.html.includes('href="/dashboard/settings#returns"');
    const orderLink = initial.html.includes(`href="/s/${FRESH_SLUG}"`);
    const whatsappBlock = itemBlock(initial.html, "whatsapp");
    const whatsappNotLinked = Boolean(whatsappBlock) && !/href=/.test(whatsappBlock);
    record(
      "3. Incomplete items link to products, Stripe settings, returns, and the storefront",
      productLink && stripeLink && returnsLink && orderLink && whatsappNotLinked,
      `product=${productLink} stripe=${stripeLink} returns=${returnsLink} order=${orderLink} whatsappUnlinked=${whatsappNotLinked}`,
    );

    const switchDoneEarly = await setActive(cookies, doneShop.id);
    const doneDash = await fetchDashboard(cookies);
    const switchBackEarly = await setActive(cookies, fresh.id);
    const freshStillOpen = await fetchDashboard(cookies);
    record(
      "6. Checklist state is per-business, not shared across shops",
      switchDoneEarly === 200 &&
        switchBackEarly === 200 &&
        !checklistPresent(doneDash.html) &&
        checklistPresent(freshStillOpen.html) &&
        itemState(freshStillOpen.html, "product") === "incomplete" &&
        doneDash.html.includes(`Setup Done ${stamp}`) &&
        freshStillOpen.html.includes(`Setup Fresh ${stamp}`),
      `doneHasChecklist=${checklistPresent(doneDash.html)} freshHasChecklist=${checklistPresent(freshStillOpen.html)}`,
    );

    const { error: addProductError } = await supabase.from("products").insert({
      business_id: fresh.id,
      name: `Fresh mug ${stamp}`,
      price_pence: 1100,
      active: true,
    });
    if (addProductError) throw new Error(addProductError.message);
    const afterProduct = await fetchDashboard(cookies);
    record(
      "2a. Adding an active product marks that item complete without a hard browser reload",
      checklistPresent(afterProduct.html) &&
        itemState(afterProduct.html, "product") === "complete" &&
        itemState(afterProduct.html, "stripe") === "incomplete",
      `product=${itemState(afterProduct.html, "product")} stripe=${itemState(afterProduct.html, "stripe")}`,
    );

    const { error: stripeError } = await supabase
      .from("businesses")
      .update({ stripe_charges_enabled: true })
      .eq("id", fresh.id);
    if (stripeError) throw new Error(stripeError.message);
    const afterStripe = await fetchDashboard(cookies);
    record(
      "2b. Enabling Stripe charges marks that item complete",
      itemState(afterStripe.html, "stripe") === "complete" &&
        itemState(afterStripe.html, "returns") === "incomplete",
      `stripe=${itemState(afterStripe.html, "stripe")} returns=${itemState(afterStripe.html, "returns")}`,
    );

    const { error: returnsError } = await supabase
      .from("businesses")
      .update({ returns_policy_text: "Returns within 14 days if unused." })
      .eq("id", fresh.id);
    if (returnsError) throw new Error(returnsError.message);
    const afterReturns = await fetchDashboard(cookies);
    record(
      "2c. Saving a returns policy marks that item complete",
      itemState(afterReturns.html, "returns") === "complete" &&
        itemState(afterReturns.html, "order") === "incomplete" &&
        checklistPresent(afterReturns.html),
      `returns=${itemState(afterReturns.html, "returns")} order=${itemState(afterReturns.html, "order")}`,
    );

    const { error: orderError } = await supabase.from("orders").insert({
      business_id: fresh.id,
      channel: "storefront",
      status: "PAID",
      total_pence: 1100,
      order_ref: `SC${stamp}F`,
    });
    if (orderError) throw new Error(orderError.message);
    const afterOrder = await fetchDashboard(cookies);
    record(
      "4. Checklist disappears once the four real items are done (WhatsApp pending does not block)",
      afterOrder.status === 200 &&
        !checklistPresent(afterOrder.html) &&
        !afterOrder.html.includes("Finish setting up your shop"),
      `present=${checklistPresent(afterOrder.html)}`,
    );

    const { data: ek } = await admin
      .from("businesses")
      .select("id, name")
      .eq("name", "EK-Pousser_D")
      .is("deleted_at", null)
      .maybeSingle();
    if (!ek) throw new Error("EK-Pousser_D not found");
    const ekSession = await mintCookies(EK_EMAIL);
    await setActive(ekSession.cookies, ek.id);
    const ekDash = await fetchDashboard(ekSession.cookies);
    record(
      "5. EK-Pousser_D does not show the setup checklist",
      ekDash.status === 200 &&
        ekDash.html.includes("EK-Pousser_D") &&
        !checklistPresent(ekDash.html),
      `status=${ekDash.status} present=${checklistPresent(ekDash.html)}`,
    );
  } finally {
    await deleteBusinesses(createdIds);
    const { data: leftover } = await admin
      .from("businesses")
      .select("id")
      .eq("owner_user_id", ownerUserId);
    if (leftover?.length) {
      await deleteBusinesses(leftover.map((row) => row.id));
    }
    await admin.auth.admin.deleteUser(ownerUserId);
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
