/**
 * Step 24a — seller home "Needs your attention".
 * Creates its own tagged shops; never touches ek-pousserd.
 *
 *   node scripts/verify-seller-attention.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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
const runId = newRunId("attn");
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

function uniqueMockPhone(slot) {
  // Stay in mock +4477009xxxxx; include run entropy so we never collide.
  const n =
    Number.parseInt(
      randomUUID().replace(/-/g, "").slice(0, 5),
      16,
    ) % 100000;
  return `+4477009${String((n + slot * 1117) % 100000).padStart(5, "0")}`;
}

async function createShop(tag, phoneSlot) {
  const email = `attn-${tag}@example.com`;
  const password = `Attn-${tag}!aA1`;
  const slug = `attn-${tag}`;
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
        name: `Attention Shop ${tag}`,
        slug,
        stripe_subscription_status: "active",
        stripe_charges_enabled: true,
        stripe_transfers_capability_active: true,
        stripe_connected_account_id: `acct_attn_${tag}`,
        whatsapp_phone_e164: uniqueMockPhone(phoneSlot + attempt),
      })
      .select(
        "id, slug, name, stripe_connected_account_id, stripe_charges_enabled, stripe_transfers_capability_active",
      )
      .single();
    if (!insert.error) {
      const business = must(insert.data, insert.error, "business insert");
      await assertNotPilotBusiness(admin, business.id, "createShop");
      return { userId, email, password, business };
    }
    lastErr = insert.error;
    if (!/whatsapp_phone|duplicate key/i.test(insert.error.message)) {
      break;
    }
  }
  await admin.auth.admin.deleteUser(userId).catch(() => {});
  throw lastErr ?? new Error("business insert failed");
}

async function seedCustomer(businessId, phone) {
  const { data, error } = await admin
    .from("customers")
    .insert({ business_id: businessId, phone_e164: phone, name: null })
    .select("id")
    .single();
  return must(data, error, "customer");
}

async function seedOrder(businessId, customerId, status, extra = {}) {
  const ref = `TF-ATTN-${randomUUID().slice(0, 6).toUpperCase()}`;
  const { data, error } = await admin
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customerId,
      order_ref: ref,
      status,
      total_pence: 1200,
      channel: "whatsapp",
      ...extra,
    })
    .select("id, order_ref, status")
    .single();
  return must(data, error, `order ${status}`);
}

async function seedDispute(businessId, orderId, suffix) {
  const due = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await admin
    .from("disputes")
    .insert({
      business_id: businessId,
      order_id: orderId,
      stripe_dispute_id: `du_attn_${suffix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      stripe_charge_id: `ch_attn_${suffix}`,
      amount_pence: 1200,
      currency: "gbp",
      reason: "general",
      status: "needs_response",
      evidence_due_by: due,
      evidence_status: "draft",
    })
    .select("id")
    .single();
  return must(data, error, "dispute");
}

function runFetchAttention(businessId) {
  const tmp = resolve(root, `scripts/_tmp_attn_${randomUUID().slice(0, 8)}.mts`);
  writeFileSync(
    tmp,
    `
import { createClient } from "@supabase/supabase-js";
import { fetchSellerAttention } from "../src/lib/dashboard/seller-attention.ts";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const { data: biz, error } = await admin
  .from("businesses")
  .select(
    "id, stripe_connected_account_id, stripe_charges_enabled, stripe_transfers_capability_active",
  )
  .eq("id", ${JSON.stringify(businessId)})
  .single();
if (error || !biz) throw new Error(error?.message ?? "business missing");
const t0 = Date.now();
const items = await fetchSellerAttention(admin, biz);
console.log(JSON.stringify({ items, ms: Date.now() - t0 }));
`,
  );
  const out = spawnSync(`npx --yes tsx "${tmp}"`, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 90_000,
    shell: true,
  });
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  if (out.status !== 0) {
    throw new Error(
      `fetchSellerAttention failed: ${(out.stderr || out.stdout || "").slice(0, 600)}`,
    );
  }
  const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

async function main() {
  console.log("=== verify-seller-attention (Step 24a) ===");
  console.log(`runId=${runId}`);

  const tagA = `${runId.replace(/^attn-/, "").slice(0, 8)}a`;
  const tagB = `${runId.replace(/^attn-/, "").slice(0, 8)}b`;
  let shopA = null;
  let shopB = null;

  try {
    shopA = await createShop(tagA, 1);
    shopB = await createShop(tagB, 2);

    // 1) Empty shop → All caught up (no items; Stripe already complete)
    const empty = runFetchAttention(shopA.business.id);
    record(
      "1. empty shop has zero attention items (All caught up)",
      empty.items.length === 0,
      `kinds=${empty.items.map((i) => i.kind).join(",") || "(none)"} ms=${empty.ms}`,
    );

    // 2) Seed dispute + return + paid undispatched on shop A
    const custA = await seedCustomer(
      shopA.business.id,
      phoneFromRunId(runId, 1),
    );
    await seedOrder(shopA.business.id, custA.id, "PAID");
    await seedOrder(shopA.business.id, custA.id, "RETURN_REQUESTED");
    const delivered = await seedOrder(
      shopA.business.id,
      custA.id,
      "DELIVERED",
    );
    await seedDispute(shopA.business.id, delivered.id, tagA);

    // Isolation seed on shop B — must not leak into A
    const custB = await seedCustomer(
      shopB.business.id,
      phoneFromRunId(runId, 2),
    );
    await seedOrder(shopB.business.id, custB.id, "PAID");
    await seedOrder(shopB.business.id, custB.id, "RETURN_REQUESTED");
    const deliveredB = await seedOrder(
      shopB.business.id,
      custB.id,
      "DELIVERED",
    );
    await seedDispute(shopB.business.id, deliveredB.id, tagB);

    const filled = runFetchAttention(shopA.business.id);
    const kinds = filled.items.map((i) => i.kind);
    const disputeIdx = kinds.indexOf("disputes");
    const returnsIdx = kinds.indexOf("returns");
    const undispIdx = kinds.indexOf("undispatched");
    const orderOk =
      disputeIdx >= 0 &&
      returnsIdx >= 0 &&
      undispIdx >= 0 &&
      disputeIdx < returnsIdx &&
      returnsIdx < undispIdx;
    const countsOk =
      filled.items.find((i) => i.kind === "disputes")?.count === 1 &&
      filled.items.find((i) => i.kind === "returns")?.count === 1 &&
      filled.items.find((i) => i.kind === "undispatched")?.count === 1;
    record(
      "2. shop A shows dispute, return, undispatched in urgency order",
      orderOk && countsOk,
      `kinds=${kinds.join(">")} countsOk=${countsOk}`,
    );

    const other = runFetchAttention(shopB.business.id);
    record(
      "3. tenant isolation — each shop sees only its own counts",
      filled.items.find((i) => i.kind === "disputes")?.count === 1 &&
        filled.items.find((i) => i.kind === "returns")?.count === 1 &&
        filled.items.find((i) => i.kind === "undispatched")?.count === 1 &&
        other.items.find((i) => i.kind === "disputes")?.count === 1 &&
        other.items.find((i) => i.kind === "returns")?.count === 1 &&
        other.items.find((i) => i.kind === "undispatched")?.count === 1,
      `A=${kinds.join(",")} B=${other.items.map((i) => i.kind).join(",")}`,
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
      const { data: leakedOrders } = await userClient
        .from("orders")
        .select("id")
        .eq("business_id", shopB.business.id);
      const { data: leakedDisputes } = await userClient
        .from("disputes")
        .select("id")
        .eq("business_id", shopB.business.id);
      rlsOk =
        (!leakedOrders || leakedOrders.length === 0) &&
        (!leakedDisputes || leakedDisputes.length === 0);
    }
    record(
      "3b. RLS: shop A session cannot read shop B orders/disputes",
      rlsOk,
      signErr?.message ?? "ok",
    );

    // 4) Performance with 2,000 extra PAID orders on shop A
    const bulkCust = await seedCustomer(
      shopA.business.id,
      phoneFromRunId(runId, 3),
    );
    const bulk = [];
    for (let i = 0; i < 2000; i++) {
      bulk.push({
        business_id: shopA.business.id,
        customer_id: bulkCust.id,
        order_ref: `TF-ATTN-BULK-${i.toString(16).padStart(4, "0")}`,
        status: "PAID",
        total_pence: 500,
        channel: "whatsapp",
      });
    }
    for (let i = 0; i < bulk.length; i += 200) {
      const chunk = bulk.slice(i, i + 200);
      const { error } = await admin.from("orders").insert(chunk);
      if (error) throw new Error(`bulk insert: ${error.message}`);
    }
    const timed = runFetchAttention(shopA.business.id);
    const undisp = timed.items.find((i) => i.kind === "undispatched");
    record(
      "4. attention query under 500ms with 2,000+ paid orders",
      timed.ms < 500 && (undisp?.count ?? 0) >= 2001,
      `ms=${timed.ms} undispatched=${undisp?.count ?? 0}`,
    );
  } finally {
    for (const shop of [shopA, shopB]) {
      if (!shop) continue;
      try {
        await assertNotPilotBusiness(admin, shop.business.id, "cleanup");
        await admin.from("disputes").delete().eq("business_id", shop.business.id);
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
