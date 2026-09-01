/**
 * Verifies live analytics + CRM stats (not analytics_cache).
 *
 *   node scripts/verify-live-analytics.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const EK_EMAIL = "sgkiket@gmail.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const LAPSED_AFTER_DAYS = 60;
const LIFETIME_STATUSES = [
  "PAID",
  "DISPATCHED",
  "DELIVERED",
  "REFUND_PENDING",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function formatGbp(pence) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}

function utcDayStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function utcWeekStart(date) {
  const start = utcDayStart(date);
  const weekday = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - (weekday - 1));
  return start;
}
function utcMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
function utcYearStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function currentWindow(range, now = new Date()) {
  if (range === "day") {
    const start = utcDayStart(now);
    return { start, end: new Date(start.getTime() + DAY_MS) };
  }
  if (range === "week") {
    const start = utcWeekStart(now);
    return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
  }
  if (range === "month") {
    const start = utcMonthStart(now);
    return {
      start,
      end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
    };
  }
  const start = utcYearStart(now);
  return { start, end: new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1)) };
}

function previousWindow(range, current) {
  if (range === "day") {
    return { start: new Date(current.start.getTime() - DAY_MS), end: current.start };
  }
  if (range === "week") {
    return { start: new Date(current.start.getTime() - 7 * DAY_MS), end: current.start };
  }
  if (range === "month") {
    const start = new Date(
      Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 1, 1),
    );
    return { start, end: current.start };
  }
  return {
    start: new Date(Date.UTC(current.start.getUTCFullYear() - 1, 0, 1)),
    end: current.start,
  };
}

function inWindow(iso, window) {
  const t = new Date(iso).getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}

function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function formatPercentChange(value) {
  if (value == null) return "No prior period";
  if (value === 0) return "0% vs prior";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}% vs prior`;
}

function totals(facts) {
  return {
    orderCount: facts.length,
    revenuePence: facts.reduce((sum, row) => sum + row.netPence, 0),
  };
}

async function mintCookies(email) {
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
    email,
  });
  if (linkError) throw linkError;
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError) throw otpError;
  return cookies;
}

async function fetchAuthed(path, cookies) {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      Accept: "text/html",
    },
    redirect: "manual",
    cache: "no-store",
  });
  return { status: response.status, html: await response.text() };
}

async function cleanupOtherUser(email) {
  const { data } = await admin.auth.admin.listUsers();
  const user = (data?.users ?? []).find((row) => row.email === email);
  if (!user) return;
  await admin.from("businesses").delete().eq("owner_user_id", user.id);
  await admin.auth.admin.deleteUser(user.id);
}

async function loadFacts(businessId) {
  const { data: history } = await admin
    .from("order_status_history")
    .select("order_id, changed_at")
    .eq("business_id", businessId)
    .eq("to_status", "PAID")
    .order("changed_at", { ascending: true });
  const firstPaid = new Map();
  for (const row of history ?? []) {
    if (!firstPaid.has(row.order_id)) firstPaid.set(row.order_id, row.changed_at);
  }
  const ids = [...firstPaid.keys()];
  if (!ids.length) return [];
  const { data: orders } = await admin
    .from("orders")
    .select("id, customer_id, total_pence, refunded_amount_pence")
    .eq("business_id", businessId)
    .in("id", ids)
    .is("deleted_at", null);
  return (orders ?? []).map((order) => {
    const totalPence = order.total_pence ?? 0;
    const refundedPence = order.refunded_amount_pence ?? 0;
    return {
      orderId: order.id,
      customerId: order.customer_id,
      paidAt: firstPaid.get(order.id),
      totalPence,
      refundedPence,
      netPence: Math.max(0, totalPence - refundedPence),
    };
  });
}

async function main() {
  const { data: business, error } = await admin
    .from("businesses")
    .select("id, name")
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !business) throw new Error("EK-Pousser_D not found");

  const facts = await loadFacts(business.id);
  const { data: cache } = await admin
    .from("analytics_cache")
    .select("period")
    .eq("business_id", business.id)
    .is("deleted_at", null)
    .order("period", { ascending: true });
  const paidDays = [...new Set(facts.map((row) => row.paidAt.slice(0, 10)))].sort();
  const earliest = paidDays[0];
  const today = new Date().toISOString().slice(0, 10);
  const expectedDays =
    earliest == null
      ? 0
      : Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${earliest}T00:00:00Z`)) / DAY_MS) +
        1;
  const cachePeriods = (cache ?? []).map((row) => row.period);
  const missing = [];
  if (earliest) {
    for (let i = 0; i < expectedDays; i += 1) {
      const day = new Date(Date.parse(`${earliest}T00:00:00Z`) + i * DAY_MS)
        .toISOString()
        .slice(0, 10);
      if (!cachePeriods.includes(day)) missing.push(day);
    }
  }
  record(
    "1. analytics_cache is a 3-day rolling snapshot, not complete shop history",
    facts.length > 0 && cachePeriods.length > 0,
    `paidOrders=${facts.length} earliestPaid=${earliest} cacheRows=${cachePeriods.length} cacheMin=${cachePeriods[0]} cacheMax=${cachePeriods[cachePeriods.length - 1]} expectedDaysSinceFirstPaid=${expectedDays} missingSinceFirstPaid=${missing.length} (EK first paid is recent so calendar gaps may be 0; cron still only rewrites last 3 UTC days)`,
  );

  const cookies = await mintCookies(EK_EMAIL);
  const rangeChecks = [];
  for (const range of ["day", "week", "month", "year"]) {
    const current = currentWindow(range);
    const inCurrent = facts.filter((row) => inWindow(row.paidAt, current));
    const expected = totals(inCurrent);
    const page = await fetchAuthed(`/dashboard/analytics?range=${range}`, cookies);
    const gbp = formatGbp(expected.revenuePence);
    const aov =
      expected.orderCount === 0
        ? 0
        : Math.round(expected.revenuePence / expected.orderCount);
    const hasToggle =
      page.html.includes(">Day<") &&
      page.html.includes(">Week<") &&
      page.html.includes(">Month<") &&
      page.html.includes(">Year<");
    const ok =
      page.status === 200 &&
      hasToggle &&
      page.html.includes("Average order value") &&
      page.html.includes(String(expected.orderCount)) &&
      page.html.includes(gbp) &&
      page.html.includes(formatGbp(aov));
    rangeChecks.push({ range, ok, expected, gbp, aov, status: page.status });
    record(
      `2. ${range} totals match live PAID-history (${expected.orderCount} / ${gbp})`,
      ok,
      `status=${page.status} orders=${expected.orderCount} revenue=${gbp} aov=${formatGbp(aov)}`,
    );
  }

  const month = currentWindow("month");
  const prev = previousWindow("month", month);
  const monthFacts = facts.filter((row) => inWindow(row.paidAt, month));
  const prevFacts = facts.filter((row) => inWindow(row.paidAt, prev));
  const monthTotals = totals(monthFacts);
  const prevTotals = totals(prevFacts);
  const change = percentChange(monthTotals.revenuePence, prevTotals.revenuePence);
  const changeLabel = formatPercentChange(change);
  const monthPage = await fetchAuthed("/dashboard/analytics?range=month", cookies);
  record(
    "3. Period-over-period % matches prior UTC month",
    monthPage.html.includes(changeLabel),
    `current=${monthTotals.revenuePence} prior=${prevTotals.revenuePence} label=${changeLabel}`,
  );

  const aov =
    monthTotals.orderCount === 0
      ? 0
      : Math.round(monthTotals.revenuePence / monthTotals.orderCount);
  const monthIds = monthFacts.map((row) => row.orderId);
  let topName = null;
  let topRevenue = 0;
  if (monthIds.length) {
    const { data: items } = await admin
      .from("order_items")
      .select(
        "order_id, quantity, unit_price_pence, product_variants(product_id, products(id, name))",
      )
      .eq("business_id", business.id)
      .in("order_id", monthIds);
    const byProduct = new Map();
    const factById = new Map(monthFacts.map((row) => [row.orderId, row]));
    for (const item of items ?? []) {
      const order = factById.get(item.order_id);
      if (!order) continue;
      const variant = Array.isArray(item.product_variants)
        ? item.product_variants[0]
        : item.product_variants;
      const product = Array.isArray(variant?.products)
        ? variant.products[0]
        : variant?.products;
      const name = product?.name?.trim() || "Unknown product";
      const scale = order.totalPence > 0 ? order.netPence / order.totalPence : 0;
      const revenue = Math.round((item.quantity ?? 0) * (item.unit_price_pence ?? 0) * scale);
      const current = byProduct.get(name) ?? 0;
      byProduct.set(name, current + revenue);
    }
    for (const [name, revenue] of byProduct) {
      if (revenue > topRevenue) {
        topRevenue = revenue;
        topName = name;
      }
    }
  }
  record(
    "4. AOV and top product match order_items for this month",
    monthPage.html.includes(formatGbp(aov)) &&
      monthPage.html.includes("Top products by revenue") &&
      (topName == null || monthPage.html.includes(topName)) &&
      (topRevenue === 0 || monthPage.html.includes(formatGbp(topRevenue))),
    `aov=${formatGbp(aov)} top=${topName} topRev=${formatGbp(topRevenue)}`,
  );

  const { data: customers } = await admin
    .from("customers")
    .select("id, name, phone_e164")
    .eq("business_id", business.id);
  const { data: allOrders } = await admin
    .from("orders")
    .select("customer_id, status, total_pence, refunded_amount_pence, created_at")
    .eq("business_id", business.id);
  const lifetime = new Map();
  for (const order of allOrders ?? []) {
    if (!LIFETIME_STATUSES.includes(order.status) || !order.customer_id) continue;
    const current = lifetime.get(order.customer_id) ?? {
      order_count: 0,
      lifetime_value_pence: 0,
      last_order_at: null,
    };
    current.order_count += 1;
    current.lifetime_value_pence += Math.max(
      0,
      (order.total_pence ?? 0) - (order.refunded_amount_pence ?? 0),
    );
    if (!current.last_order_at || order.created_at > current.last_order_at) {
      current.last_order_at = order.created_at;
    }
    lifetime.set(order.customer_id, current);
  }
  const ranked = (customers ?? [])
    .map((row) => ({
      ...row,
      ...(lifetime.get(row.id) ?? {
        order_count: 0,
        lifetime_value_pence: 0,
        last_order_at: null,
      }),
    }))
    .filter((row) => row.lifetime_value_pence > 0)
    .sort((a, b) => b.lifetime_value_pence - a.lifetime_value_pence);
  const topCustomer = ranked[0];
  const firstByCustomer = new Map();
  const sortedFacts = [...facts].sort((a, b) => a.paidAt.localeCompare(b.paidAt));
  for (const fact of sortedFacts) {
    if (!fact.customerId) continue;
    if (!firstByCustomer.has(fact.customerId)) firstByCustomer.set(fact.customerId, fact.orderId);
  }
  let repeatRevenue = 0;
  for (const fact of monthFacts) {
    const isNew = !fact.customerId || firstByCustomer.get(fact.customerId) === fact.orderId;
    if (!isNew) repeatRevenue += fact.netPence;
  }
  const repeatShare =
    monthTotals.revenuePence === 0
      ? 0
      : Math.round((repeatRevenue / monthTotals.revenuePence) * 100);
  const customersPage = await fetchAuthed("/dashboard/customers?range=month", cookies);
  const topOk =
    customersPage.status === 200 &&
    customersPage.html.includes("Top customers by lifetime value") &&
    topCustomer &&
    customersPage.html.includes(topCustomer.name || topCustomer.phone_e164) &&
    customersPage.html.includes(formatGbp(topCustomer.lifetime_value_pence));
  const splitOk = customersPage.html.includes(
    `${repeatShare}% of revenue from repeat customers`,
  );
  record(
    "5. Top customers ranking and new/repeat split match live data",
    topOk && splitOk,
    `top=${topCustomer?.name} ltv=${formatGbp(topCustomer?.lifetime_value_pence ?? 0)} repeatShare=${repeatShare}%`,
  );

  const now = Date.now();
  const lapsed = ranked.filter((row) => {
    if (!row.last_order_at) return false;
    return now - new Date(row.last_order_at).getTime() > LAPSED_AFTER_DAYS * DAY_MS;
  });
  const lapsedAlsoZero = (customers ?? []).filter((row) => {
    const stats = lifetime.get(row.id);
    return (
      stats?.last_order_at &&
      now - new Date(stats.last_order_at).getTime() > LAPSED_AFTER_DAYS * DAY_MS
    );
  });
  const lapsedCount = lapsedAlsoZero.length;
  const lapsedPhrase =
    lapsedCount === 0
      ? `Lapsed: 0 customers beyond ${LAPSED_AFTER_DAYS} days.`
      : `${lapsedCount} customer${lapsedCount === 1 ? "" : "s"} haven't ordered in ${LAPSED_AFTER_DAYS}+ days`;
  const analyticsPage = await fetchAuthed("/dashboard/analytics", cookies);
  const lapsedOk =
    customersPage.html.includes(
      lapsedCount === 0
        ? `Lapsed: 0 customers beyond ${LAPSED_AFTER_DAYS} days.`
        : `${lapsedCount} customer`,
    ) &&
    analyticsPage.html.includes(
      lapsedCount === 0
        ? `Lapsed: 0 customers beyond ${LAPSED_AFTER_DAYS} days.`
        : `${lapsedCount} customer`,
    );
  record(
    "6. Lapsed banner count is accurate on customers and analytics",
    lapsedOk,
    `lapsedCount=${lapsedCount} rankedLapsed=${lapsed.length} phrase=${lapsedPhrase}`,
  );

  const OTHER_EMAIL = `analytics-other-${Date.now()}@tradeflow-test.local`;
  await cleanupOtherUser(OTHER_EMAIL);
  const { data: otherUser } = await admin.auth.admin.createUser({
    email: OTHER_EMAIL,
    email_confirm: true,
  });
  await admin.from("businesses").insert({
    owner_user_id: otherUser.user.id,
    name: "Analytics Other Shop",
    slug: `analytics-other-${Date.now()}`,
    dispatch_address_line1: "2 Other St",
    dispatch_city: "London",
    dispatch_postcode: "E2 2BB",
  });
  const otherCookies = await mintCookies(OTHER_EMAIL);
  const otherAnalytics = await fetchAuthed("/dashboard/analytics?range=month", otherCookies);
  const otherCustomers = await fetchAuthed("/dashboard/customers", otherCookies);
  const distinctive = [
    "Draft Order Tester",
    "Customer Repeat Verify",
    formatGbp(topCustomer?.lifetime_value_pence ?? 0),
  ];
  const leaked = distinctive.filter(
    (value) =>
      value &&
      value !== "£0.00" &&
      (otherAnalytics.html.includes(value) || otherCustomers.html.includes(value)),
  );
  record(
    "7. Other business cannot see EK analytics or customers",
    otherAnalytics.status === 200 &&
      otherCustomers.status === 200 &&
      leaked.length === 0 &&
      !otherCustomers.html.includes("Customer Repeat Verify"),
    `otherAnalytics=${otherAnalytics.status} otherCustomers=${otherCustomers.status} leaked=${JSON.stringify(leaked)}`,
  );
  await cleanupOtherUser(OTHER_EMAIL);

  const allPassed = results.every((row) => row.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("rangeChecks", JSON.stringify(rangeChecks));
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
