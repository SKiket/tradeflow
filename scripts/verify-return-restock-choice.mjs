/**
 * Step 24e-1 — markReturned restock choice (server side).
 * Own tagged shops; never touches ek-pousserd.
 *
 *   node scripts/verify-return-restock-choice.mjs
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  assertNotPilotBusiness,
  createAdmin,
  deleteTestBusiness,
  loadVerifyEnv,
  newRunId,
  phoneFromRunId,
  PILOT_SLUG,
} from "./lib/verify-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadVerifyEnv();
const admin = createAdmin();
const runId = newRunId("rrc");
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
  return `+4477009${String((n + slot * 1703) % 100000).padStart(5, "0")}`;
}

async function createShop(tag, phoneSlot) {
  const email = `rrc-${tag}@example.com`;
  const password = `Rrc-${tag}!aA1`;
  const slug = `rrc-${tag}`;
  if (slug === PILOT_SLUG || slug.startsWith("ek-pousser")) {
    throw new Error("refusing pilot");
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
        name: `RRC Shop ${tag}`,
        slug,
        stripe_subscription_status: "active",
        stripe_charges_enabled: true,
        stripe_transfers_capability_active: true,
        stripe_connected_account_id: `acct_rrc_${tag}`,
        whatsapp_phone_e164: uniquePhone(phoneSlot + attempt),
      })
      .select("id, slug")
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

async function seedVariant(businessId, { stock = 10, track = true } = {}) {
  const { data: product, error } = await admin
    .from("products")
    .insert({
      business_id: businessId,
      name: `RRC Product ${randomUUID().slice(0, 6)}`,
      price_pence: 1000,
    })
    .select("id")
    .single();
  must(product, error, "product");
  const { data: variant, error: vErr } = await admin
    .from("product_variants")
    .insert({
      business_id: businessId,
      product_id: product.id,
      label: track ? "Tracked" : "Untracked",
      stock_quantity: stock,
      reserved_quantity: 0,
      track_inventory: track,
    })
    .select("id, stock_quantity, track_inventory")
    .single();
  must(variant, vErr, "variant");
  return { product, variant };
}

async function seedCustomer(businessId, phone) {
  const { data, error } = await admin
    .from("customers")
    .insert({ business_id: businessId, phone_e164: phone, name: null })
    .select("id")
    .single();
  return must(data, error, "customer");
}

async function seedReturnApproved(businessId, customerId, variantId, qty = 1) {
  const ref = `TF-RRC-${randomUUID().slice(0, 6).toUpperCase()}`;
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customerId,
      order_ref: ref,
      status: "AWAITING_PAYMENT",
      total_pence: 1000 * qty,
      channel: "whatsapp",
      return_reason: "wrong_size",
      return_requested_at: new Date().toISOString(),
    })
    .select("id, order_ref")
    .single();
  must(order, error, "order");
  const { error: iErr } = await admin.from("order_items").insert({
    order_id: order.id,
    business_id: businessId,
    product_variant_id: variantId,
    quantity: qty,
    unit_price_pence: 1000,
  });
  if (iErr) throw new Error(iErr.message);
  await admin.rpc("fulfil_paid_order", { p_order_id: order.id });
  const { error: uErr } = await admin
    .from("orders")
    .update({
      status: "RETURN_APPROVED",
      return_decided_at: new Date().toISOString(),
    })
    .eq("id", order.id);
  if (uErr) throw new Error(uErr.message);
  return order;
}

function runMarkReturnedAsync(orderId, options) {
  const tmp = resolve(
    root,
    `scripts/_tmp_rrc_${randomUUID().slice(0, 8)}.mts`,
  );
  const optsLiteral =
    options === undefined ? "" : `, ${JSON.stringify(options)}`;
  writeFileSync(
    tmp,
    `
import { createClient } from "@supabase/supabase-js";
import { markReturned } from "../src/lib/orders/request-return.ts";
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const result = await markReturned(admin, ${JSON.stringify(orderId)}${optsLiteral});
console.log(JSON.stringify(result));
`,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(`npx --yes tsx "${tmp}"`, {
      cwd: root,
      env: process.env,
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("markReturned timeout"));
    }, 60_000);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      if (code !== 0) {
        reject(
          new Error(
            `markReturned failed: ${(stderr || stdout || "").slice(0, 400)}`,
          ),
        );
        return;
      }
      try {
        const line = stdout.trim().split("\n").filter(Boolean).pop();
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function stockOf(variantId) {
  const { data, error } = await admin
    .from("product_variants")
    .select("stock_quantity")
    .eq("id", variantId)
    .single();
  if (error) throw error;
  return data.stock_quantity;
}

async function restockMoves(variantId, orderId) {
  const { data, error } = await admin
    .from("inventory_movements")
    .select("id, change, stock_after, reason, order_id")
    .eq("variant_id", variantId)
    .eq("reason", "restock_return")
    .eq("order_id", orderId);
  if (error) throw error;
  return data ?? [];
}

async function orderFlags(orderId) {
  const { data, error } = await admin
    .from("orders")
    .select("status, return_restocked")
    .eq("id", orderId)
    .single();
  if (error) throw error;
  return data;
}

async function main() {
  console.log("=== verify-return-restock-choice (Step 24e-1) ===");
  console.log(`runId=${runId}`);
  const tagA = `${runId.replace(/^rrc-/, "").slice(0, 8)}a`;
  const tagB = `${runId.replace(/^rrc-/, "").slice(0, 8)}b`;
  let shopA = null;
  let shopB = null;

  try {
    shopA = await createShop(tagA, 1);
    shopB = await createShop(tagB, 2);
    const cust = await seedCustomer(
      shopA.business.id,
      phoneFromRunId(runId, 1),
    );

    // --- 1. restock true ---
    const { variant: v1 } = await seedVariant(shopA.business.id, { stock: 20 });
    const o1 = await seedReturnApproved(
      shopA.business.id,
      cust.id,
      v1.id,
      2,
    );
    const before1 = await stockOf(v1.id);
    const out1 = await runMarkReturnedAsync(o1.id, { restock: true });
    const after1 = await stockOf(v1.id);
    const moves1 = await restockMoves(v1.id, o1.id);
    const flags1 = await orderFlags(o1.id);
    record(
      "1. restock true → stock +qty, one movement, return_restocked true",
      out1.action === "returned" &&
        after1 === before1 + 2 &&
        moves1.length === 1 &&
        moves1[0].change === 2 &&
        flags1.return_restocked === true &&
        flags1.status === "RETURNED",
      `before=${before1} after=${after1} moves=${JSON.stringify(moves1)} flags=${JSON.stringify(flags1)} out=${JSON.stringify(out1)}`,
    );

    // --- 2. restock false ---
    const { variant: v2 } = await seedVariant(shopA.business.id, { stock: 15 });
    const o2 = await seedReturnApproved(
      shopA.business.id,
      cust.id,
      v2.id,
      1,
    );
    const before2 = await stockOf(v2.id);
    const out2 = await runMarkReturnedAsync(o2.id, { restock: false });
    const after2 = await stockOf(v2.id);
    const moves2 = await restockMoves(v2.id, o2.id);
    const flags2 = await orderFlags(o2.id);
    record(
      "2. restock false → stock unchanged, no movement, return_restocked false",
      out2.action === "returned" &&
        after2 === before2 &&
        moves2.length === 0 &&
        flags2.return_restocked === false,
      `before=${before2} after=${after2} moves=${moves2.length} flags=${JSON.stringify(flags2)}`,
    );

    // --- 3. flag omitted (= true) ---
    const { variant: v3 } = await seedVariant(shopA.business.id, { stock: 12 });
    const o3 = await seedReturnApproved(
      shopA.business.id,
      cust.id,
      v3.id,
      1,
    );
    const before3 = await stockOf(v3.id);
    const out3 = await runMarkReturnedAsync(o3.id);
    const after3 = await stockOf(v3.id);
    const moves3 = await restockMoves(v3.id, o3.id);
    const flags3 = await orderFlags(o3.id);
    record(
      "3. flag omitted → same as restock true",
      out3.action === "returned" &&
        after3 === before3 + 1 &&
        moves3.length === 1 &&
        flags3.return_restocked === true,
      `before=${before3} after=${after3} moves=${moves3.length} flags=${JSON.stringify(flags3)}`,
    );

    // --- 4. untracked only ---
    const { variant: v4 } = await seedVariant(shopA.business.id, {
      stock: 8,
      track: false,
    });
    const o4 = await seedReturnApproved(
      shopA.business.id,
      cust.id,
      v4.id,
      1,
    );
    const before4 = await stockOf(v4.id);
    const out4 = await runMarkReturnedAsync(o4.id, { restock: true });
    const after4 = await stockOf(v4.id);
    const moves4 = await restockMoves(v4.id, o4.id);
    const flags4 = await orderFlags(o4.id);
    record(
      "4. untracked only → no stock change, return_restocked null",
      out4.action === "returned" &&
        after4 === before4 &&
        moves4.length === 0 &&
        flags4.return_restocked === null,
      `before=${before4} after=${after4} flags=${JSON.stringify(flags4)}`,
    );

    // --- 5a. double submit ---
    const { variant: v5 } = await seedVariant(shopA.business.id, { stock: 10 });
    const o5 = await seedReturnApproved(
      shopA.business.id,
      cust.id,
      v5.id,
      1,
    );
    const before5 = await stockOf(v5.id);
    const first5 = await runMarkReturnedAsync(o5.id, { restock: true });
    const second5 = await runMarkReturnedAsync(o5.id, { restock: true });
    const after5 = await stockOf(v5.id);
    const moves5 = await restockMoves(v5.id, o5.id);
    const flags5 = await orderFlags(o5.id);
    record(
      "5a. double submit → one restock only, first choice kept",
      first5.action === "returned" &&
        second5.action === "returned" &&
        after5 === before5 + 1 &&
        moves5.length === 1 &&
        flags5.return_restocked === true,
      `stock ${before5}→${after5} moves=${moves5.length} first=${JSON.stringify(first5)} second=${JSON.stringify(second5)}`,
    );

    // --- 5b. simultaneous calls (true vs false) ---
    const { variant: v6 } = await seedVariant(shopA.business.id, { stock: 10 });
    const o6 = await seedReturnApproved(
      shopA.business.id,
      cust.id,
      v6.id,
      1,
    );
    const before6 = await stockOf(v6.id);
    const [rA, rB] = await Promise.all([
      runMarkReturnedAsync(o6.id, { restock: true }),
      runMarkReturnedAsync(o6.id, { restock: false }),
    ]);
    const after6 = await stockOf(v6.id);
    const moves6 = await restockMoves(v6.id, o6.id);
    const flags6 = await orderFlags(o6.id);
    const delta6 = after6 - before6;
    const choiceKept =
      (flags6.return_restocked === true &&
        delta6 === 1 &&
        moves6.length === 1) ||
      (flags6.return_restocked === false &&
        delta6 === 0 &&
        moves6.length === 0);
    record(
      "5b. simultaneous true+false → one winner, at most one restock, first choice kept",
      rA.action === "returned" &&
        rB.action === "returned" &&
        choiceKept &&
        moves6.length <= 1,
      `stock ${before6}→${after6} moves=${moves6.length} flags=${JSON.stringify(flags6)} A=${JSON.stringify(rA)} B=${JSON.stringify(rB)}`,
    );

    // --- 6. tenant isolation ---
    const userB = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error: signErr } = await userB.auth.signInWithPassword({
      email: shopB.email,
      password: shopB.password,
    });
    let isoOk = false;
    let isoDetail = signErr?.message ?? "";
    if (!signErr) {
      const { variant: vIso } = await seedVariant(shopA.business.id, {
        stock: 5,
      });
      const oIso = await seedReturnApproved(
        shopA.business.id,
        cust.id,
        vIso.id,
        1,
      );
      const beforeIso = await stockOf(vIso.id);
      // Call markReturned as shop B (RLS) via temp script using B's session.
      const tmp = resolve(
        root,
        `scripts/_tmp_rrc_iso_${randomUUID().slice(0, 6)}.mts`,
      );
      writeFileSync(
        tmp,
        `
import { createClient } from "@supabase/supabase-js";
import { markReturned } from "../src/lib/orders/request-return.ts";
const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const { error } = await client.auth.signInWithPassword({
  email: ${JSON.stringify(shopB.email)},
  password: ${JSON.stringify(shopB.password)},
});
if (error) { console.log(JSON.stringify({ action: "sign_error", error: error.message })); process.exit(0); }
const result = await markReturned(client, ${JSON.stringify(oIso.id)}, { restock: true });
console.log(JSON.stringify(result));
`,
      );
      const out = await new Promise((resolve, reject) => {
        const child = spawn(`npx --yes tsx "${tmp}"`, {
          cwd: root,
          env: process.env,
          shell: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
          stdout += d;
        });
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.on("close", (code) => {
          try {
            unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          if (code !== 0) {
            reject(new Error((stderr || stdout).slice(0, 300)));
            return;
          }
          resolve(JSON.parse(stdout.trim().split("\n").filter(Boolean).pop()));
        });
      });
      const afterIso = await stockOf(vIso.id);
      const flagsIso = await orderFlags(oIso.id);
      isoOk =
        out.action === "not_found" &&
        afterIso === beforeIso &&
        flagsIso.status === "RETURN_APPROVED" &&
        flagsIso.return_restocked === null;
      isoDetail = `out=${JSON.stringify(out)} stock ${beforeIso}→${afterIso} flags=${JSON.stringify(flagsIso)}`;
    }
    record(
      "6. shop B seller cannot mark shop A order returned",
      isoOk,
      isoDetail,
    );

    // --- 7. forced restock failure → full rollback; then retry succeeds ---
    const { variant: vFail } = await seedVariant(shopA.business.id, {
      stock: 10,
    });
    const oFail = await seedReturnApproved(
      shopA.business.id,
      cust.id,
      vFail.id,
      1,
    );
    const beforeFail = await stockOf(vFail.id);
    const { error: installErr } = await admin.rpc(
      "verify_install_restock_fail_trigger",
    );
    if (installErr) throw installErr;
    let failOut;
    try {
      failOut = await runMarkReturnedAsync(oFail.id, { restock: true });
    } finally {
      await admin.rpc("verify_remove_restock_fail_trigger");
    }
    const afterFail = await stockOf(vFail.id);
    const movesFail = await restockMoves(vFail.id, oFail.id);
    const flagsFail = await orderFlags(oFail.id);
    record(
      "7a. forced restock failure → order unchanged, no movement, mark_returned_failed",
      failOut.action === "mark_returned_failed" &&
        afterFail === beforeFail &&
        movesFail.length === 0 &&
        flagsFail.status === "RETURN_APPROVED" &&
        flagsFail.return_restocked === null,
      `out=${JSON.stringify(failOut)} stock ${beforeFail}→${afterFail} moves=${movesFail.length} flags=${JSON.stringify(flagsFail)}`,
    );

    const retryOut = await runMarkReturnedAsync(oFail.id, { restock: true });
    const afterRetry = await stockOf(vFail.id);
    const movesRetry = await restockMoves(vFail.id, oFail.id);
    const flagsRetry = await orderFlags(oFail.id);
    record(
      "7b. after removing fail trigger, retry restocks exactly once",
      retryOut.action === "returned" &&
        afterRetry === beforeFail + 1 &&
        movesRetry.length === 1 &&
        flagsRetry.status === "RETURNED" &&
        flagsRetry.return_restocked === true,
      `out=${JSON.stringify(retryOut)} stock ${beforeFail}→${afterRetry} moves=${movesRetry.length} flags=${JSON.stringify(flagsRetry)}`,
    );
  } finally {
    try {
      await admin.rpc("verify_remove_restock_fail_trigger");
    } catch {
      /* ignore */
    }
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
