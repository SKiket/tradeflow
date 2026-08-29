/**
 * Verifies low-stock alerts + analytics aggregate (Step E2):
 *  1. Drop stock to/below threshold → one batched WhatsApp, alerted_at set, UI badge
 *  2. Immediate re-run does not duplicate
 *  3. Restock → alerted_at cleared, badge gone
 *  4. analytics_cache matches PAID-history count/sum (partial refund nets out)
 *  5. /dashboard/analytics shows those numbers; tenant-a RLS isolation
 *  6. pg_cron jobs registered (checked separately via cron.job)
 *
 * Requires Next.js with CRON_SHARED_SECRET. Run:
 *   node scripts/verify-low-stock-and-analytics.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EK_EMAIL = "sgkiket@gmail.com";
const TENANT_A = {
  email: "tenant-a@tradeflow-test.local",
  password: "TestTenantA!123",
};
const SELLER = process.env.SELLER_PHONE ?? "+447733308706";
const RECOMPUTE_DAYS = 3;

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
const CRON_SECRET = env.CRON_SHARED_SECRET;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function utcPeriodKey(date) {
  return date.toISOString().slice(0, 10);
}

function utcDayStart(daysAgo) {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo),
  );
}

function available(row) {
  return Math.max(0, (row.stock_quantity ?? 0) - (row.reserved_quantity ?? 0));
}

function isLow(row) {
  if (!row.track_inventory) return false;
  return available(row) <= (row.low_stock_threshold ?? 0);
}

async function postCron(path) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": CRON_SECRET,
    },
    body: "{}",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function countLowStockMessages(businessId, sellerPhone, sinceIso) {
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", sellerPhone);
  const ids = (customers ?? []).map((c) => c.id);
  if (!ids.length) return [];
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text, created_at")
    .in("customer_id", ids)
    .eq("direction", "outbound")
    .eq("business_id", businessId)
    .gte("created_at", sinceIso)
    .ilike("normalised_text", "%Low stock:%")
    .order("created_at", { ascending: true });
  return data ?? [];
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

async function fetchDashboard(path, cookies) {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      Cookie: cookieHeader(cookies),
      "Cache-Control": "no-cache",
    },
    cache: "no-store",
    redirect: "manual",
  });
  const html = await response.text();
  return { status: response.status, location: response.headers.get("location"), html };
}

function productHasLowStockBadge(html, productId) {
  const marker = `/dashboard/products/${productId}`;
  const idx = html.indexOf(marker);
  if (idx < 0) return false;
  return html.slice(idx, idx + 280).includes("Low stock");
}

function userClientFromSession(session) {
  return createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
}

async function expectedAnalytics(businessId) {
  const windowStart = utcDayStart(RECOMPUTE_DAYS - 1);
  const windowEnd = utcDayStart(-1);
  const { data: history, error } = await admin
    .from("order_status_history")
    .select("order_id, business_id, changed_at")
    .eq("to_status", "PAID")
    .eq("business_id", businessId)
    .gte("changed_at", windowStart.toISOString())
    .lt("changed_at", windowEnd.toISOString())
    .order("changed_at", { ascending: true });
  if (error) throw error;

  const firstPaid = new Map();
  for (const row of history ?? []) {
    if (firstPaid.has(row.order_id)) continue;
    firstPaid.set(row.order_id, utcPeriodKey(new Date(row.changed_at)));
  }

  const orderIds = [...firstPaid.keys()];
  const amounts = new Map();
  if (orderIds.length) {
    const { data: orders, error: orderError } = await admin
      .from("orders")
      .select("id, total_pence, refunded_amount_pence, status, order_ref")
      .in("id", orderIds)
      .is("deleted_at", null);
    if (orderError) throw orderError;
    for (const order of orders ?? []) {
      amounts.set(order.id, order);
    }
  }

  const byPeriod = new Map();
  for (const [orderId, period] of firstPaid) {
    const order = amounts.get(orderId);
    if (!order) continue;
    const current = byPeriod.get(period) ?? { order_count: 0, revenue_pence: 0, orders: [] };
    current.order_count += 1;
    current.revenue_pence += Math.max(
      0,
      (order.total_pence ?? 0) - (order.refunded_amount_pence ?? 0),
    );
    current.orders.push(order);
    byPeriod.set(period, current);
  }
  return { byPeriod, firstPaid, amounts };
}

async function cooldownOtherBusinesses(ekId) {
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const { data: variants } = await admin
    .from("product_variants")
    .select(
      "id, business_id, stock_quantity, reserved_quantity, low_stock_threshold, track_inventory, low_stock_alerted_at",
    )
    .neq("business_id", ekId)
    .is("deleted_at", null);
  const toHold = [];
  for (const row of variants ?? []) {
    if (!isLow(row)) continue;
    if (row.low_stock_alerted_at && row.low_stock_alerted_at >= cutoff) continue;
    toHold.push({ id: row.id, previous: row.low_stock_alerted_at });
  }
  if (toHold.length) {
    await admin
      .from("product_variants")
      .update({ low_stock_alerted_at: new Date().toISOString() })
      .in(
        "id",
        toHold.map((row) => row.id),
      );
  }
  return toHold;
}

async function restoreCooldowns(held) {
  for (const row of held) {
    await admin
      .from("product_variants")
      .update({ low_stock_alerted_at: row.previous })
      .eq("id", row.id);
  }
}

async function main() {
  if (!CRON_SECRET) throw new Error("CRON_SHARED_SECRET missing from .env.local");

  const { data: business } = await admin
    .from("businesses")
    .select("id, name, seller_whatsapp_phone_e164")
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");

  const previousSellerPhone = business.seller_whatsapp_phone_e164;
  await admin
    .from("businesses")
    .update({ seller_whatsapp_phone_e164: SELLER })
    .eq("id", business.id);

  const { data: variants } = await admin
    .from("product_variants")
    .select(
      "id, product_id, label, stock_quantity, reserved_quantity, low_stock_threshold, track_inventory, low_stock_alerted_at, products(name)",
    )
    .eq("business_id", business.id)
    .eq("track_inventory", true)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  const tracked = variants ?? [];
  if (!tracked.length) throw new Error("No tracked variants on EK-Pousser_D");

  const productId = tracked[0].product_id;
  let testVariants = tracked.filter((row) => row.product_id === productId);
  if (testVariants.length === 1) {
    const extra = tracked.find((row) => row.product_id !== productId);
    if (extra) testVariants = [testVariants[0], extra];
  }
  const snapshots = testVariants.map((row) => ({
    id: row.id,
    product_id: row.product_id,
    name: Array.isArray(row.products) ? row.products[0]?.name : row.products?.name,
    stock_quantity: row.stock_quantity,
    reserved_quantity: row.reserved_quantity,
    low_stock_alerted_at: row.low_stock_alerted_at,
    low_stock_threshold: row.low_stock_threshold,
  }));

  const otherHolds = await cooldownOtherBusinesses(business.id);

  try {
    for (const row of snapshots) {
      await admin
        .from("product_variants")
        .update({
          stock_quantity: row.reserved_quantity ?? 0,
          low_stock_alerted_at: null,
        })
        .eq("id", row.id);
    }

    const since = new Date().toISOString();
    const first = await postCron("/api/cron/low-stock-alerts");
    const afterFirst = await admin
      .from("product_variants")
      .select("id, low_stock_alerted_at, stock_quantity, reserved_quantity")
      .in(
        "id",
        snapshots.map((row) => row.id),
      );
    const msgs1 = await countLowStockMessages(business.id, SELLER, since);
    const allAlerted = (afterFirst.data ?? []).every((row) => row.low_stock_alerted_at);
    const batched = testVariants.length > 1
      ? (msgs1[0]?.normalised_text ?? "").split("\n").filter((l) => l.startsWith("• ")).length >=
        testVariants.length
      : true;

    record(
      "1. Low-stock cron sends one batched WhatsApp and sets low_stock_alerted_at",
      first.status === 200 &&
        first.json.ok &&
        first.json.businessesAlerted >= 1 &&
        msgs1.length === 1 &&
        allAlerted &&
        batched,
      `status=${first.status} businessesAlerted=${first.json.businessesAlerted} variantsAlerted=${first.json.variantsAlerted} messages=${msgs1.length} alerted=${allAlerted} batched=${batched} body=${JSON.stringify(msgs1[0]?.normalised_text ?? "")}`,
    );

    const ekAuth = await mintCookies(EK_EMAIL, null);
    const productsLow = await fetchDashboard("/dashboard/products", ekAuth.cookies);
    const badgeVisible = productHasLowStockBadge(productsLow.html, productId);
    record(
      "1b. Products list shows live low-stock indicator",
      productsLow.status === 200 && badgeVisible,
      `status=${productsLow.status} productId=${productId} badgeVisible=${badgeVisible}`,
    );

    const second = await postCron("/api/cron/low-stock-alerts");
    const msgs2 = await countLowStockMessages(business.id, SELLER, since);
    record(
      "2. Immediate re-run does not duplicate the alert",
      second.status === 200 &&
        second.json.ok &&
        second.json.businessesAlerted === 0 &&
        msgs2.length === 1,
      `businessesAlerted=${second.json.businessesAlerted} messages=${msgs2.length}`,
    );

    for (const row of snapshots) {
      const restockTo = Math.max(
        (row.reserved_quantity ?? 0) + (row.low_stock_threshold ?? 0) + 5,
        20,
      );
      await admin
        .from("product_variants")
        .update({ stock_quantity: restockTo })
        .eq("id", row.id);
    }
    const third = await postCron("/api/cron/low-stock-alerts");
    const afterClear = await admin
      .from("product_variants")
      .select("id, low_stock_alerted_at")
      .in(
        "id",
        snapshots.map((row) => row.id),
      );
    const cleared = (afterClear.data ?? []).every((row) => row.low_stock_alerted_at == null);
    const productsOk = await fetchDashboard("/dashboard/products", ekAuth.cookies);
    const badgeGone = !productHasLowStockBadge(productsOk.html, productId);
    record(
      "3. Restock clears low_stock_alerted_at and removes the dashboard indicator",
      third.status === 200 && third.json.ok && cleared && badgeGone,
      `cleared=${cleared} variantsCleared=${third.json.variantsCleared} badgeGone=${badgeGone}`,
    );

    const expected = await expectedAnalytics(business.id);
    const agg = await postCron("/api/cron/analytics-aggregate");
    const periods = Array.from({ length: RECOMPUTE_DAYS }, (_, i) =>
      utcPeriodKey(utcDayStart(i)),
    );
    const { data: cacheRows } = await admin
      .from("analytics_cache")
      .select("period, revenue_pence, order_count")
      .eq("business_id", business.id)
      .in("period", periods)
      .is("deleted_at", null);
    const cacheByPeriod = new Map(
      (cacheRows ?? []).map((row) => [row.period, row]),
    );
    let cacheMatches = agg.status === 200 && agg.json.ok;
    const mismatches = [];
    for (const period of periods) {
      const exp = expected.byPeriod.get(period) ?? { order_count: 0, revenue_pence: 0 };
      const got = cacheByPeriod.get(period) ?? { order_count: 0, revenue_pence: 0 };
      if (got.order_count !== exp.order_count || got.revenue_pence !== exp.revenue_pence) {
        cacheMatches = false;
        mismatches.push(
          `${period} expected ${exp.order_count}/${exp.revenue_pence} got ${got.order_count}/${got.revenue_pence}`,
        );
      }
    }

    const { data: partials } = await admin
      .from("orders")
      .select("id, order_ref, status, total_pence, refunded_amount_pence")
      .eq("business_id", business.id)
      .gt("refunded_amount_pence", 0)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(5);
    const partial = (partials ?? []).find((row) => expected.amounts.has(row.id));
    const partialNetOk = partial
      ? expected.amounts.get(partial.id).total_pence -
          expected.amounts.get(partial.id).refunded_amount_pence ===
        Math.max(0, partial.total_pence - partial.refunded_amount_pence)
      : false;

    record(
      "4. analytics_cache matches PAID-history count/sum (partial refund nets out)",
      cacheMatches && !!partial && partialNetOk,
      `upserted=${agg.json.rowsUpserted} mismatches=${mismatches.join(" | ") || "none"} partial=${partial ? `${partial.order_ref} ${partial.status} total=${partial.total_pence} refunded=${partial.refunded_amount_pence} net=${partial.total_pence - partial.refunded_amount_pence}` : "NONE IN WINDOW"}`,
    );

    const analyticsHtml = await fetchDashboard("/dashboard/analytics", ekAuth.cookies);
    const navHasAnalytics =
      analyticsHtml.html.includes(">Analytics<") || analyticsHtml.html.includes("Analytics");
    const navSoonOnAnalytics = /Analytics[\s\S]{0,80}Soon/.test(analyticsHtml.html);
    const totalsMatch = periods.some((period) => {
      const row = cacheByPeriod.get(period);
      if (!row || !row.order_count) return true;
      return (
        analyticsHtml.html.includes(period) &&
        analyticsHtml.html.includes(String(row.order_count))
      );
    });
    const revenueShown = (cacheRows ?? []).some((row) => {
      if (!row.revenue_pence) return false;
      const pounds = (row.revenue_pence / 100).toFixed(2);
      return analyticsHtml.html.includes(pounds);
    });

    record(
      "5a. /dashboard/analytics shows cached numbers and live Analytics nav",
      analyticsHtml.status === 200 &&
        navHasAnalytics &&
        !navSoonOnAnalytics &&
        totalsMatch &&
        (revenueShown || (cacheRows ?? []).every((row) => !row.revenue_pence)),
      `status=${analyticsHtml.status} nav=${navHasAnalytics} soon=${navSoonOnAnalytics} totalsMatch=${totalsMatch} revenueShown=${revenueShown}`,
    );

    const tenantAuth = await mintCookies(TENANT_A.email, TENANT_A.password);
    const tenantUser = tenantAuth.supabase;
    const {
      data: { session: tenantSession },
    } = await tenantUser.auth.getSession();
    const tenantClient = userClientFromSession(tenantSession);
    const { data: cross } = await tenantClient
      .from("analytics_cache")
      .select("id, period, revenue_pence, business_id")
      .eq("business_id", business.id);
    const tenantPage = await fetchDashboard("/dashboard/analytics", tenantAuth.cookies);
    const tenantSeesEkRevenue = (cacheRows ?? []).some((row) => {
      if (!row.revenue_pence) return false;
      const pounds = (row.revenue_pence / 100).toFixed(2);
      return tenantPage.html.includes(pounds) && tenantPage.html.includes(row.period);
    });

    record(
      "5b. Other business cannot read EK-Pousser_D analytics (RLS)",
      (cross ?? []).length === 0 && tenantPage.status === 200 && !tenantSeesEkRevenue,
      `crossRows=${(cross ?? []).length} tenantStatus=${tenantPage.status} tenantSeesEkRevenue=${tenantSeesEkRevenue}`,
    );
  } finally {
    for (const row of snapshots) {
      await admin
        .from("product_variants")
        .update({
          stock_quantity: row.stock_quantity,
          low_stock_alerted_at: row.low_stock_alerted_at,
        })
        .eq("id", row.id);
    }
    await restoreCooldowns(otherHolds);
    await admin
      .from("businesses")
      .update({ seller_whatsapp_phone_e164: previousSellerPhone })
      .eq("id", business.id);
  }

  const failed = results.filter((row) => !row.passed).length;
  console.log("\n========================================");
  console.log(
    failed === 0
      ? "LOW-STOCK + ANALYTICS VERIFICATION: PASSED"
      : `LOW-STOCK + ANALYTICS VERIFICATION: ${failed} FAILED`,
  );
  console.log("========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
