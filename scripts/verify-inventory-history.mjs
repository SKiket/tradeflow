/**
 * Step 24d — inventory movement history.
 * Own tagged shops; never touches ek-pousserd.
 *
 *   node scripts/verify-inventory-history.mjs
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
const runId = newRunId("inv");
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
  return `+4477009${String((n + slot * 1601) % 100000).padStart(5, "0")}`;
}

async function createShop(tag, phoneSlot) {
  const email = `inv-${tag}@example.com`;
  const password = `Inv-${tag}!aA1`;
  const slug = `inv-${tag}`;
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
        name: `Inv Shop ${tag}`,
        slug,
        stripe_subscription_status: "active",
        stripe_charges_enabled: true,
        stripe_transfers_capability_active: true,
        stripe_connected_account_id: `acct_inv_${tag}`,
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

async function seedVariant(businessId, stock = 10) {
  const { data: product, error } = await admin
    .from("products")
    .insert({
      business_id: businessId,
      name: `Inv Product ${randomUUID().slice(0, 6)}`,
      price_pence: 1000,
    })
    .select("id")
    .single();
  must(product, error, "product");
  await admin.rpc("set_inventory_movement_context", {
    p_reason: "initial",
    p_order_id: null,
  });
  const { data: variant, error: vErr } = await admin
    .from("product_variants")
    .insert({
      business_id: businessId,
      product_id: product.id,
      label: "Default",
      stock_quantity: stock,
      reserved_quantity: 0,
      track_inventory: true,
    })
    .select("id, stock_quantity")
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

async function seedAwaitingOrder(businessId, customerId, variantId, qty = 1) {
  const ref = `TF-INV-${randomUUID().slice(0, 6).toUpperCase()}`;
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customerId,
      order_ref: ref,
      status: "AWAITING_PAYMENT",
      total_pence: 1000 * qty,
      channel: "whatsapp",
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
  return order;
}

function runMarkReturned(orderId) {
  const tmp = resolve(root, `scripts/_tmp_inv_ret_${randomUUID().slice(0, 6)}.mts`);
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
const result = await markReturned(admin, ${JSON.stringify(orderId)});
console.log(JSON.stringify(result));
`,
  );
  const out = spawnSync(`npx --yes tsx "${tmp}"`, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: true,
    timeout: 60_000,
  });
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  if (out.status !== 0) {
    throw new Error(
      `markReturned failed: ${(out.stderr || out.stdout || "").slice(0, 400)}`,
    );
  }
  const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

async function latestMovement(variantId) {
  const { data, error } = await admin
    .from("inventory_movements")
    .select("*")
    .eq("variant_id", variantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function main() {
  console.log("=== verify-inventory-history (Step 24d) ===");
  console.log(`runId=${runId}`);
  const tagA = `${runId.replace(/^inv-/, "").slice(0, 8)}a`;
  const tagB = `${runId.replace(/^inv-/, "").slice(0, 8)}b`;
  let shopA = null;
  let shopB = null;

  try {
    shopA = await createShop(tagA, 1);
    shopB = await createShop(tagB, 2);
    const { variant } = await seedVariant(shopA.business.id, 10);
    const cust = await seedCustomer(
      shopA.business.id,
      phoneFromRunId(runId, 1),
    );

    // 1a) Sale via fulfil_paid_order
    const saleOrder = await seedAwaitingOrder(
      shopA.business.id,
      cust.id,
      variant.id,
      1,
    );
    const { data: fulfilRes, error: fErr } = await admin.rpc(
      "fulfil_paid_order",
      { p_order_id: saleOrder.id },
    );
    if (fErr) throw fErr;
    const saleMove = await latestMovement(variant.id);
    const { data: afterSale } = await admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", variant.id)
      .single();
    record(
      "1a. sale produces sale movement with stock_after",
      fulfilRes === "fulfilled" &&
        saleMove?.reason === "sale" &&
        saleMove.change === -1 &&
        saleMove.stock_after === 9 &&
        saleMove.order_id === saleOrder.id &&
        afterSale.stock_quantity === 9,
      `fulfil=${fulfilRes} move=${JSON.stringify(saleMove)} stock=${afterSale.stock_quantity}`,
    );

    // 1b) Cancellation restock — cancel only releases reserved today; verify
    // labels a stock increase with restock_cancellation via adjust_variant_stock.
    const { error: cErr } = await admin.rpc("adjust_variant_stock", {
      p_variant_id: variant.id,
      p_stock_quantity: 10,
      p_reason: "restock_cancellation",
      p_order_id: saleOrder.id,
    });
    if (cErr) throw cErr;
    const cancelMove = await latestMovement(variant.id);
    record(
      "1b. restock_cancellation movement",
      cancelMove?.reason === "restock_cancellation" &&
        cancelMove.change === 1 &&
        cancelMove.stock_after === 10 &&
        cancelMove.order_id === saleOrder.id,
      JSON.stringify(cancelMove),
    );

    // 1c) Return restock via markReturned
    const retOrder = await seedAwaitingOrder(
      shopA.business.id,
      cust.id,
      variant.id,
      1,
    );
    await admin.rpc("fulfil_paid_order", { p_order_id: retOrder.id });
    await admin
      .from("orders")
      .update({
        status: "RETURN_APPROVED",
        return_requested_at: new Date().toISOString(),
        return_reason: "wrong_size",
      })
      .eq("id", retOrder.id);
    const beforeRet = (
      await admin
        .from("product_variants")
        .select("stock_quantity")
        .eq("id", variant.id)
        .single()
    ).data.stock_quantity;
    const retOutcome = runMarkReturned(retOrder.id);
    const retMove = await latestMovement(variant.id);
    const afterRet = (
      await admin
        .from("product_variants")
        .select("stock_quantity")
        .eq("id", variant.id)
        .single()
    ).data.stock_quantity;
    record(
      "1c. return restock via markReturned",
      retOutcome.action === "returned" &&
        retMove?.reason === "restock_return" &&
        retMove.change === 1 &&
        retMove.stock_after === beforeRet + 1 &&
        afterRet === beforeRet + 1 &&
        retMove.order_id === retOrder.id,
      `action=${retOutcome.action} before=${beforeRet} after=${afterRet} move=${JSON.stringify(retMove)}`,
    );

    // 1d) Manual adjustment
    const { error: mErr } = await admin.rpc("adjust_variant_stock", {
      p_variant_id: variant.id,
      p_stock_quantity: afterRet + 5,
      p_reason: "manual_adjustment",
      p_order_id: null,
    });
    if (mErr) throw mErr;
    const manMove = await latestMovement(variant.id);
    record(
      "1d. manual_adjustment movement",
      manMove?.reason === "manual_adjustment" &&
        manMove.change === 5 &&
        manMove.stock_after === afterRet + 5,
      JSON.stringify(manMove),
    );

    // 2) Concurrent sales of last unit
    const { variant: lastVar } = await seedVariant(shopA.business.id, 1);
    const o1 = await seedAwaitingOrder(
      shopA.business.id,
      cust.id,
      lastVar.id,
      1,
    );
    const o2 = await seedAwaitingOrder(
      shopA.business.id,
      cust.id,
      lastVar.id,
      1,
    );
    const [r1, r2] = await Promise.all([
      admin.rpc("fulfil_paid_order", { p_order_id: o1.id }),
      admin.rpc("fulfil_paid_order", { p_order_id: o2.id }),
    ]);
    const resultsFulfil = [r1.data, r2.data];
    const { data: lastStock } = await admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", lastVar.id)
      .single();
    const { data: saleRows } = await admin
      .from("inventory_movements")
      .select("change, stock_after")
      .eq("variant_id", lastVar.id)
      .eq("reason", "sale");
    const noNegative = (saleRows ?? []).every((r) => r.stock_after >= 0);
    record(
      "2. concurrent last-unit sales: no negative stock_after, stock ends 0",
      lastStock.stock_quantity === 0 &&
        noNegative &&
        (saleRows?.length ?? 0) >= 1,
      `fulfil=${JSON.stringify(resultsFulfil)} stock=${lastStock.stock_quantity} sales=${JSON.stringify(saleRows)}`,
    );

    // 3) Tenant isolation + no update/delete for seller
    const { variant: bVar } = await seedVariant(shopB.business.id, 3);
    const userClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error: signErr } = await userClient.auth.signInWithPassword({
      email: shopA.email,
      password: shopA.password,
    });
    let isoOk = false;
    let noWrite = false;
    if (!signErr) {
      const { data: leaked } = await userClient
        .from("inventory_movements")
        .select("id")
        .eq("business_id", shopB.business.id);
      isoOk = !leaked || leaked.length === 0;
      const { data: own } = await userClient
        .from("inventory_movements")
        .select("id")
        .eq("variant_id", variant.id)
        .limit(1);
      const ownId = own?.[0]?.id;
      if (ownId) {
        const { error: upErr } = await userClient
          .from("inventory_movements")
          .update({ change: 999 })
          .eq("id", ownId);
        const { error: delErr } = await userClient
          .from("inventory_movements")
          .delete()
          .eq("id", ownId);
        const { data: still } = await admin
          .from("inventory_movements")
          .select("change")
          .eq("id", ownId)
          .maybeSingle();
        noWrite =
          Boolean(upErr || delErr || still) &&
          still?.change !== 999;
      } else {
        noWrite = true;
      }
    }
    record(
      "3. tenant isolation + seller cannot update/delete movements",
      !signErr && isoOk && noWrite,
      `leak=${!isoOk} writeBlocked=${noWrite} bVar=${bVar.id}`,
    );

    // 4) 5,000 movements query under 300ms
    const { variant: bulkVar } = await seedVariant(shopA.business.id, 0);
    const bulk = [];
    for (let i = 0; i < 5000; i++) {
      bulk.push({
        business_id: shopA.business.id,
        variant_id: bulkVar.id,
        change: 1,
        stock_after: i + 1,
        reason: "other",
      });
    }
    for (let i = 0; i < bulk.length; i += 500) {
      const { error } = await admin
        .from("inventory_movements")
        .insert(bulk.slice(i, i + 500));
      if (error) throw new Error(`bulk move: ${error.message}`);
    }
    const t0 = Date.now();
    const { data: page, error: qErr } = await admin
      .from("inventory_movements")
      .select("id, change, stock_after, reason, created_at")
      .eq("business_id", shopA.business.id)
      .eq("variant_id", bulkVar.id)
      .order("created_at", { ascending: false })
      .limit(20);
    const ms = Date.now() - t0;
    record(
      "4. history page query under 300ms with 5,000 movements",
      !qErr && ms < 300 && (page?.length ?? 0) === 20,
      `ms=${ms} rows=${page?.length}`,
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
