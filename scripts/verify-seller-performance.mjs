/**
 * Step 24b — seller Performance page.
 * Own tagged shops only; never touches ek-pousserd.
 *
 *   node scripts/verify-seller-performance.mjs
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  createAdmin,
  deleteTestBusiness,
  loadVerifyEnv,
  newRunId,
  phoneFromRunId,
  PILOT_SLUG,
  assertNotPilotBusiness,
} from "./lib/verify-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadVerifyEnv();
const admin = createAdmin();
const runId = newRunId("perf");
const results = [];

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function must(data, error, label) {
  if (error) throw new Error(`${label}: ${error.message}`);
  if (!data) throw new Error(`${label}: no data`);
  return data;
}

function uniquePhone(slot) {
  const n =
    Number.parseInt(randomUUID().replace(/-/g, "").slice(0, 5), 16) % 100000;
  return `+4477009${String((n + slot * 1301) % 100000).padStart(5, "0")}`;
}

async function createShop(tag, phoneSlot) {
  const email = `perf-${tag}@example.com`;
  const password = `Perf-${tag}!aA1`;
  const slug = `perf-${tag}`;
  if (slug === PILOT_SLUG || slug.startsWith("ek-pousser")) {
    throw new Error("refusing pilot slug");
  }
  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (uErr) throw uErr;
  const userId = created.user.id;

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const insert = await admin
      .from("businesses")
      .insert({
        owner_user_id: userId,
        name: `Perf Shop ${tag}`,
        slug,
        stripe_subscription_status: "active",
        stripe_charges_enabled: true,
        stripe_transfers_capability_active: true,
        stripe_connected_account_id: `acct_perf_${tag}`,
        whatsapp_phone_e164: uniquePhone(phoneSlot + attempt),
      })
      .select("id, slug, name")
      .single();
    if (!insert.error) {
      await assertNotPilotBusiness(admin, insert.data.id, "createShop");
      return { userId, email, password, business: insert.data };
    }
    lastErr = insert.error;
    if (!/whatsapp_phone|duplicate key/i.test(insert.error.message)) break;
  }
  await admin.auth.admin.deleteUser(userId).catch(() => {});
  throw lastErr ?? new Error("business insert failed");
}

async function seedCatalog(businessId) {
  const products = [];
  for (const [name, price] of [
    ["Alpha Widget", 1000],
    ["Beta Gadget", 2000],
    ["Gamma Kit", 500],
  ]) {
    const { data: product, error } = await admin
      .from("products")
      .insert({
        business_id: businessId,
        name,
        price_pence: price,
      })
      .select("id, name, price_pence")
      .single();
    must(product, error, `product ${name}`);
    const { data: variant, error: vErr } = await admin
      .from("product_variants")
      .insert({
        business_id: businessId,
        product_id: product.id,
        label: "Default",
        stock_quantity: 9999,
        reserved_quantity: 0,
        track_inventory: false,
      })
      .select("id")
      .single();
    must(variant, vErr, `variant ${name}`);
    products.push({ ...product, variantId: variant.id });
  }
  return products;
}

async function seedCustomer(businessId, phone) {
  const { data, error } = await admin
    .from("customers")
    .insert({ business_id: businessId, phone_e164: phone, name: null })
    .select("id")
    .single();
  return must(data, error, "customer");
}

async function seedOrder({
  businessId,
  customerId,
  status,
  totalPence,
  channel,
  createdAt,
  paidAt,
  refundedPence = 0,
  items = [],
}) {
  const ref = `TF-PERF-${randomUUID().slice(0, 6).toUpperCase()}`;
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customerId,
      order_ref: ref,
      status,
      total_pence: totalPence,
      refunded_amount_pence: refundedPence,
      channel,
      created_at: createdAt,
    })
    .select("id, order_ref, status")
    .single();
  must(order, error, `order ${status}`);

  for (const item of items) {
    const { error: iErr } = await admin.from("order_items").insert({
      order_id: order.id,
      business_id: businessId,
      product_variant_id: item.variantId,
      quantity: item.qty,
      unit_price_pence: item.unitPricePence,
    });
    if (iErr) throw new Error(`item: ${iErr.message}`);
  }

  if (paidAt) {
    const { error: hErr } = await admin.from("order_status_history").insert({
      order_id: order.id,
      business_id: businessId,
      from_status: "AWAITING_PAYMENT",
      to_status: "PAID",
      changed_at: paidAt,
    });
    if (hErr) throw new Error(`history: ${hErr.message}`);
  }
  return order;
}

function daysAgoIso(days, hour = 12) {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function runSummarize(businessId, days, nowIso) {
  const tmp = resolve(root, `scripts/_tmp_perf_${randomUUID().slice(0, 8)}.mts`);
  writeFileSync(
    tmp,
    `
import { createClient } from "@supabase/supabase-js";
import { fetchPaidOrderFacts, fetchPaidOrderItems } from "../src/lib/analytics/paid-orders.ts";
import { rollingWindow } from "../src/lib/analytics/performance-periods.ts";
import { summarizePerformance } from "../src/lib/analytics/performance-summarize.ts";
import { ORDER_STATUS } from "../src/lib/orders/status.ts";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const businessId = ${JSON.stringify(businessId)};
const days = ${days};
const now = new Date(${JSON.stringify(nowIso)});
const t0 = Date.now();
const { facts, error } = await fetchPaidOrderFacts(admin, businessId);
if (error) throw new Error(error);
const window = rollingWindow(days, now);
const paidIds = new Set(
  facts
    .filter((f) => {
      const t = new Date(f.paidAt).getTime();
      return t >= window.start.getTime() && t < window.end.getTime();
    })
    .map((f) => f.orderId),
);
const { data: cancelledRows } = await admin
  .from("orders")
  .select("id")
  .eq("business_id", businessId)
  .eq("status", ORDER_STATUS.CANCELLED)
  .is("deleted_at", null)
  .gte("created_at", window.start.toISOString())
  .lt("created_at", window.end.toISOString());
const cancelledUnpaid = (cancelledRows ?? []).filter((r) => !paidIds.has(r.id)).length;
const { items } = await fetchPaidOrderItems(admin, businessId, [...paidIds]);
const summary = summarizePerformance(facts, items, days, cancelledUnpaid, now);
console.log(JSON.stringify({
  ms: Date.now() - t0,
  empty: summary.empty,
  sales: summary.sales,
  orders: summary.orders,
  aov: summary.aov,
  refundAmountPence: summary.refundAmountPence,
  refundCount: summary.refundCount,
  returnCount: summary.returnCount,
  statusCounts: summary.statusCounts,
  topProducts: summary.topProducts.map((p) => ({ name: p.name, units: p.units, salesPence: p.salesPence })),
  channel: summary.channel,
}));
`,
  );
  const out = spawnSync(`npx --yes tsx "${tmp}"`, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: true,
    timeout: 90_000,
  });
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  if (out.status !== 0) {
    throw new Error(
      `summarize failed: ${(out.stderr || out.stdout || "").slice(0, 600)}`,
    );
  }
  const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

async function main() {
  console.log("=== verify-seller-performance (Step 24b) ===");
  console.log(`runId=${runId}`);
  const tagA = `${runId.replace(/^perf-/, "").slice(0, 8)}a`;
  const tagB = `${runId.replace(/^perf-/, "").slice(0, 8)}b`;
  let shopA = null;
  let shopB = null;
  const nowIso = new Date().toISOString();

  try {
    shopA = await createShop(tagA, 1);
    shopB = await createShop(tagB, 2);
    const catalog = await seedCatalog(shopA.business.id);
    const [alpha, beta, gamma] = catalog;
    const cust = await seedCustomer(shopA.business.id, phoneFromRunId(runId, 1));

    // Current 30d window seeds:
    // 1) Paid whatsapp Alpha×2 = 2000 net
    await seedOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      status: "PAID",
      totalPence: 2000,
      channel: "whatsapp",
      createdAt: daysAgoIso(5),
      paidAt: daysAgoIso(5),
      items: [{ variantId: alpha.variantId, qty: 2, unitPricePence: 1000 }],
    });
    // 2) Paid storefront Beta×1 = 2000, then refunded 500 → net 1500
    await seedOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      status: "PARTIALLY_REFUNDED",
      totalPence: 2000,
      refundedPence: 500,
      channel: "storefront",
      createdAt: daysAgoIso(3),
      paidAt: daysAgoIso(3),
      items: [{ variantId: beta.variantId, qty: 1, unitPricePence: 2000 }],
    });
    // 3) Paid Gamma×3 = 1500, dispatched
    await seedOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      status: "DISPATCHED",
      totalPence: 1500,
      channel: "whatsapp",
      createdAt: daysAgoIso(2),
      paidAt: daysAgoIso(2),
      items: [{ variantId: gamma.variantId, qty: 3, unitPricePence: 500 }],
    });
    // 4) Cancelled unpaid — not in sales
    await seedOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      status: "CANCELLED",
      totalPence: 9999,
      channel: "whatsapp",
      createdAt: daysAgoIso(1),
      paidAt: null,
      items: [],
    });
    // 5) Unpaid awaiting — not in sales
    await seedOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      status: "AWAITING_PAYMENT",
      totalPence: 8000,
      channel: "storefront",
      createdAt: daysAgoIso(1),
      paidAt: null,
      items: [],
    });

    // Previous period (31–60 days ago): one paid order £10 so comparison works
    await seedOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      status: "DELIVERED",
      totalPence: 1000,
      channel: "whatsapp",
      createdAt: daysAgoIso(40),
      paidAt: daysAgoIso(40),
      items: [{ variantId: alpha.variantId, qty: 1, unitPricePence: 1000 }],
    });

    // Expected current 30d:
    // sales = 2000 + 1500 + 1500 = 5000
    // orders = 3
    // aov = round(5000/3) = 1667
    // refund amount = 500, refund count = 1
    // top by units: Gamma 3, Alpha 2, Beta 1
    const summary = runSummarize(shopA.business.id, 30, nowIso);
    const salesOk = summary.sales.value === 5000;
    const ordersOk = summary.orders.value === 3;
    const aovOk = summary.aov.value === 1667;
    const refundOk =
      summary.refundAmountPence.value === 500 &&
      summary.refundCount.value === 1;
    record(
      "1. seeded shop sales/orders/AOV/refunds match",
      salesOk && ordersOk && aovOk && refundOk,
      `sales=${summary.sales.value} orders=${summary.orders.value} aov=${summary.aov.value} refund=${summary.refundAmountPence.value}/${summary.refundCount.value}`,
    );

    // Prior period had £10 sales → change is defined; sales change = (5000-1000)/1000 = 400%
    record(
      "2a. period comparison has prior base (not no-previous)",
      summary.sales.changePercent != null && summary.sales.previous === 1000,
      `change=${summary.sales.changePercent} previous=${summary.sales.previous}`,
    );

    // Zero-base: use 7-day window on a shop with only old prior? Better: empty previous for 7d
    // Seed nothing in days 8-14 relative to a shop that only has last 5 days...
    // Our previous 7d window is empty (paid at day 40 only + current within 5).
    const s7 = runSummarize(shopA.business.id, 7, nowIso);
    record(
      "2b. zero-base prior → changePercent null (no previous data)",
      s7.sales.previous === 0 && s7.sales.changePercent == null,
      `previous=${s7.sales.previous} change=${s7.sales.changePercent}`,
    );

    const topNames = summary.topProducts.map((p) => p.name);
    const topUnits = summary.topProducts.map((p) => p.units);
    record(
      "3. top products by units: Gamma, Alpha, Beta",
      topNames[0] === "Gamma Kit" &&
        topUnits[0] === 3 &&
        topNames[1] === "Alpha Widget" &&
        topUnits[1] === 2 &&
        topNames[2] === "Beta Gadget" &&
        topUnits[2] === 1,
      `top=${JSON.stringify(summary.topProducts)}`,
    );

    record(
      "3b. channel split whatsapp vs storefront",
      summary.channel.whatsappCount === 2 &&
        summary.channel.storefrontCount === 1,
      `wa=${summary.channel.whatsappCount} web=${summary.channel.storefrontCount}`,
    );

    record(
      "3c. cancelled unpaid counted in status, not in sales",
      summary.statusCounts.cancelled >= 1 && summary.orders.value === 3,
      `cancelled=${summary.statusCounts.cancelled}`,
    );

    // Tenant B noise
    const custB = await seedCustomer(
      shopB.business.id,
      phoneFromRunId(runId, 2),
    );
    const catB = await seedCatalog(shopB.business.id);
    await seedOrder({
      businessId: shopB.business.id,
      customerId: custB.id,
      status: "PAID",
      totalPence: 99900,
      channel: "whatsapp",
      createdAt: daysAgoIso(1),
      paidAt: daysAgoIso(1),
      items: [
        {
          variantId: catB[0].variantId,
          qty: 1,
          unitPricePence: 99900,
        },
      ],
    });
    const again = runSummarize(shopA.business.id, 30, nowIso);
    record(
      "4. tenant isolation — shop A sales unchanged by shop B",
      again.sales.value === 5000 && again.orders.value === 3,
      `sales=${again.sales.value}`,
    );

    const userClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error: signErr } = await userClient.auth.signInWithPassword({
      email: shopA.email,
      password: shopA.password,
    });
    let rlsOk = false;
    if (!signErr) {
      const { data: leaked } = await userClient
        .from("orders")
        .select("id")
        .eq("business_id", shopB.business.id);
      rlsOk = !leaked || leaked.length === 0;
    }
    record("4b. RLS: A session cannot read B orders", rlsOk, signErr?.message ?? "ok");

    // 2,000 paid orders performance
    const bulkCust = await seedCustomer(
      shopA.business.id,
      phoneFromRunId(runId, 3),
    );
    const bulkOrders = [];
    for (let i = 0; i < 2000; i++) {
      bulkOrders.push({
        business_id: shopA.business.id,
        customer_id: bulkCust.id,
        order_ref: `TF-PERF-${tagA}-B${i.toString(16).padStart(4, "0")}`,
        status: "PAID",
        total_pence: 100,
        channel: "whatsapp",
        created_at: daysAgoIso(4),
      });
    }
    const insertedIds = [];
    for (let i = 0; i < bulkOrders.length; i += 200) {
      const chunk = bulkOrders.slice(i, i + 200);
      const { data, error } = await admin
        .from("orders")
        .insert(chunk)
        .select("id");
      if (error) throw new Error(`bulk orders: ${error.message}`);
      for (const row of data ?? []) insertedIds.push(row.id);
    }
    const hist = insertedIds.map((id) => ({
      order_id: id,
      business_id: shopA.business.id,
      from_status: "AWAITING_PAYMENT",
      to_status: "PAID",
      changed_at: daysAgoIso(4),
    }));
    for (let i = 0; i < hist.length; i += 200) {
      const { error } = await admin
        .from("order_status_history")
        .insert(hist.slice(i, i + 200));
      if (error) throw new Error(`bulk history: ${error.message}`);
    }

    const timed = runSummarize(shopA.business.id, 30, nowIso);
    record(
      "5. 2,000+ paid orders summarize under 1000ms",
      timed.ms < 1000 && timed.orders.value >= 2003,
      `ms=${timed.ms} orders=${timed.orders.value}`,
    );
  } finally {
    for (const shop of [shopA, shopB]) {
      if (!shop) continue;
      try {
        await assertNotPilotBusiness(admin, shop.business.id, "cleanup");
        await deleteTestBusiness(admin, shop.business.id, {
          ownerUserId: shop.userId,
        });
      } catch (e) {
        console.warn("cleanup:", e.message);
      }
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(
    `\n=== Summary: ${results.length - failed} passed, ${failed} failed ===`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
