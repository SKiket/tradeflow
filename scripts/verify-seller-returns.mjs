/**
 * Step 24c — seller Returns list.
 * Own tagged shops only; never touches ek-pousserd.
 *
 *   node scripts/verify-seller-returns.mjs
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
const runId = newRunId("ret");
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
  return `+4477009${String((n + slot * 1409) % 100000).padStart(5, "0")}`;
}

async function createShop(tag, phoneSlot) {
  const email = `ret-${tag}@example.com`;
  const password = `Ret-${tag}!aA1`;
  const slug = `ret-${tag}`;
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
        name: `Returns Shop ${tag}`,
        slug,
        stripe_subscription_status: "active",
        stripe_charges_enabled: true,
        stripe_transfers_capability_active: true,
        stripe_connected_account_id: `acct_ret_${tag}`,
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

async function seedCustomer(businessId, phone) {
  const { data, error } = await admin
    .from("customers")
    .insert({ business_id: businessId, phone_e164: phone, name: "Alex Buyer" })
    .select("id")
    .single();
  return must(data, error, "customer");
}

async function seedCatalog(businessId) {
  const { data: product, error } = await admin
    .from("products")
    .insert({
      business_id: businessId,
      name: "Return Tee",
      price_pence: 1500,
    })
    .select("id")
    .single();
  must(product, error, "product");
  const { data: variant, error: vErr } = await admin
    .from("product_variants")
    .insert({
      business_id: businessId,
      product_id: product.id,
      label: "M",
      stock_quantity: 50,
      reserved_quantity: 0,
      track_inventory: false,
    })
    .select("id")
    .single();
  must(variant, vErr, "variant");
  return { product, variant };
}

async function seedReturnOrder({
  businessId,
  customerId,
  variantId,
  status,
  requestedAt,
  orderRef,
  refundedPence = 0,
  reason = "wrong_size",
}) {
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customerId,
      order_ref: orderRef,
      status,
      total_pence: 1500,
      refunded_amount_pence: refundedPence,
      channel: "whatsapp",
      return_reason: reason,
      return_reason_detail: "Too small in the chest",
      return_requested_at: requestedAt,
      return_decided_at:
        status === "RETURN_REQUESTED" ? null : requestedAt,
    })
    .select("id, order_ref, status, return_requested_at")
    .single();
  must(order, error, `order ${status}`);
  const { error: iErr } = await admin.from("order_items").insert({
    order_id: order.id,
    business_id: businessId,
    product_variant_id: variantId,
    quantity: 1,
    unit_price_pence: 1500,
  });
  if (iErr) throw new Error(`item: ${iErr.message}`);
  return order;
}

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function runFetch(businessId) {
  const tmp = resolve(root, `scripts/_tmp_ret_${randomUUID().slice(0, 8)}.mts`);
  writeFileSync(
    tmp,
    `
import { createClient } from "@supabase/supabase-js";
import { fetchReturnsList } from "../src/lib/returns/list-returns.ts";
import { countReturnsNeedingDecision } from "../src/lib/returns/count-pending.ts";
import { fetchSellerAttention } from "../src/lib/dashboard/seller-attention.ts";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const businessId = ${JSON.stringify(businessId)};
const { data: biz } = await admin
  .from("businesses")
  .select("id, stripe_connected_account_id, stripe_charges_enabled, stripe_transfers_capability_active")
  .eq("id", businessId)
  .single();

const t0 = Date.now();
const needs = await fetchReturnsList(admin, businessId, "needs_decision", 1);
const approved = await fetchReturnsList(admin, businessId, "approved", 1);
const declined = await fetchReturnsList(admin, businessId, "declined", 1);
const closed = await fetchReturnsList(admin, businessId, "closed", 1);
const sharedCount = await countReturnsNeedingDecision(admin, businessId);
const attention = await fetchSellerAttention(admin, biz);
const attentionReturns = attention.find((i) => i.kind === "returns");
console.log(JSON.stringify({
  msNeeds: needs.queryMs,
  totals: needs.totals,
  needsRefs: needs.rows.map((r) => r.orderRef),
  approvedRefs: approved.rows.map((r) => r.orderRef),
  declinedRefs: declined.rows.map((r) => r.orderRef),
  closedRefs: closed.rows.map((r) => r.orderRef),
  sharedCount,
  attentionCount: attentionReturns?.count ?? 0,
  attentionHref: attentionReturns?.href ?? null,
  wallMs: Date.now() - t0,
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
      `fetch failed: ${(out.stderr || out.stdout || "").slice(0, 600)}`,
    );
  }
  const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

function runPageTiming(businessId) {
  const tmp = resolve(root, `scripts/_tmp_ret_t_${randomUUID().slice(0, 8)}.mts`);
  writeFileSync(
    tmp,
    `
import { createClient } from "@supabase/supabase-js";
import { fetchReturnsList } from "../src/lib/returns/list-returns.ts";
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const list = await fetchReturnsList(admin, ${JSON.stringify(businessId)}, "needs_decision", 1);
console.log(JSON.stringify({ ms: list.queryMs, total: list.total, rows: list.rows.length }));
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
      `timing failed: ${(out.stderr || out.stdout || "").slice(0, 400)}`,
    );
  }
  const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

async function main() {
  console.log("=== verify-seller-returns (Step 24c) ===");
  console.log(`runId=${runId}`);
  const tagA = `${runId.replace(/^ret-/, "").slice(0, 8)}a`;
  const tagB = `${runId.replace(/^ret-/, "").slice(0, 8)}b`;
  let shopA = null;
  let shopB = null;

  try {
    shopA = await createShop(tagA, 1);
    shopB = await createShop(tagB, 2);
    const cust = await seedCustomer(shopA.business.id, phoneFromRunId(runId, 1));
    const { variant } = await seedCatalog(shopA.business.id);

    // Oldest needs decision first: 72h ago, then 24h ago
    const oldest = await seedReturnOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      variantId: variant.id,
      status: "RETURN_REQUESTED",
      requestedAt: hoursAgoIso(72),
      orderRef: `TF-RET-${tagA}-OLD`,
    });
    const newerNeed = await seedReturnOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      variantId: variant.id,
      status: "RETURN_REQUESTED",
      requestedAt: hoursAgoIso(24),
      orderRef: `TF-RET-${tagA}-NEW`,
    });
    const approved = await seedReturnOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      variantId: variant.id,
      status: "RETURN_APPROVED",
      requestedAt: hoursAgoIso(10),
      orderRef: `TF-RET-${tagA}-APR`,
    });
    const declined = await seedReturnOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      variantId: variant.id,
      status: "RETURN_DECLINED",
      requestedAt: hoursAgoIso(8),
      orderRef: `TF-RET-${tagA}-DEC`,
    });
    const closed = await seedReturnOrder({
      businessId: shopA.business.id,
      customerId: cust.id,
      variantId: variant.id,
      status: "REFUNDED",
      requestedAt: hoursAgoIso(5),
      orderRef: `TF-RET-${tagA}-CLD`,
      refundedPence: 1500,
    });

    const snap = runFetch(shopA.business.id);
    record(
      "1. tabs land seeded returns with right counts",
      snap.totals.needs_decision === 2 &&
        snap.totals.approved === 1 &&
        snap.totals.declined === 1 &&
        snap.totals.closed === 1 &&
        snap.needsRefs.includes(oldest.order_ref) &&
        snap.needsRefs.includes(newerNeed.order_ref) &&
        snap.approvedRefs.includes(approved.order_ref) &&
        snap.declinedRefs.includes(declined.order_ref) &&
        snap.closedRefs.includes(closed.order_ref),
      `totals=${JSON.stringify(snap.totals)}`,
    );

    record(
      "2. Needs decision count equals attention returns count",
      snap.sharedCount === 2 &&
        snap.attentionCount === 2 &&
        snap.totals.needs_decision === snap.attentionCount &&
        snap.attentionHref === "/dashboard/returns?tab=needs_decision",
      `shared=${snap.sharedCount} attention=${snap.attentionCount} href=${snap.attentionHref}`,
    );

    record(
      "3. Needs decision ordered oldest first",
      snap.needsRefs[0] === oldest.order_ref &&
        snap.needsRefs[1] === newerNeed.order_ref,
      `order=${snap.needsRefs.join(">")}`,
    );

    // Shop B noise
    const custB = await seedCustomer(
      shopB.business.id,
      phoneFromRunId(runId, 2),
    );
    const catB = await seedCatalog(shopB.business.id);
    await seedReturnOrder({
      businessId: shopB.business.id,
      customerId: custB.id,
      variantId: catB.variant.id,
      status: "RETURN_REQUESTED",
      requestedAt: hoursAgoIso(1),
      orderRef: `TF-RET-${tagB}-ISO`,
    });
    const again = runFetch(shopA.business.id);
    record(
      "4. tenant isolation — shop B return excluded from A",
      again.totals.needs_decision === 2 &&
        !again.needsRefs.some((r) => r.includes(tagB)),
      `needs=${again.totals.needs_decision} refs=${again.needsRefs.join(",")}`,
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
        .eq("business_id", shopB.business.id)
        .eq("status", "RETURN_REQUESTED");
      rlsOk = !leaked || leaked.length === 0;
    }
    record("4b. RLS A cannot read B returns", rlsOk, signErr?.message ?? "ok");

    // 1,000 RETURN_REQUESTED for page timing
    const bulk = [];
    for (let i = 0; i < 1000; i++) {
      bulk.push({
        business_id: shopA.business.id,
        customer_id: cust.id,
        order_ref: `TF-RET-${tagA}-B${i.toString(16).padStart(4, "0")}`,
        status: "RETURN_REQUESTED",
        total_pence: 1000,
        channel: "whatsapp",
        return_reason: "changed_mind",
        return_requested_at: hoursAgoIso(1 + (i % 200)),
      });
    }
    for (let i = 0; i < bulk.length; i += 200) {
      const { error } = await admin.from("orders").insert(bulk.slice(i, i + 200));
      if (error) throw new Error(`bulk: ${error.message}`);
    }
    const timed = runPageTiming(shopA.business.id);
    record(
      "5. 1,000 returns page under 500ms",
      timed.ms < 500 && timed.total >= 1002 && timed.rows === 25,
      `ms=${timed.ms} total=${timed.total} rows=${timed.rows}`,
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
