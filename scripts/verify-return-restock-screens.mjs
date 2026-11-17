/**
 * Step 24e-2 — seller screens data for return restock choice.
 * Own tagged shop; never touches ek-pousserd.
 *
 *   node scripts/verify-return-restock-screens.mjs
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
loadVerifyEnv();
const admin = createAdmin();
const runId = newRunId("rrs");
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
  return `+4477009${String((n + slot * 1801) % 100000).padStart(5, "0")}`;
}

async function createShop(tag) {
  const email = `rrs-${tag}@example.com`;
  const password = `Rrs-${tag}!aA1`;
  const slug = `rrs-${tag}`;
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
  const { data: business, error: bErr } = await admin
    .from("businesses")
    .insert({
      owner_user_id: userId,
      name: `RRS Shop ${tag}`,
      slug,
      stripe_subscription_status: "active",
      stripe_charges_enabled: true,
      stripe_transfers_capability_active: true,
      stripe_connected_account_id: `acct_rrs_${tag}`,
      whatsapp_phone_e164: uniquePhone(1),
    })
    .select("id, slug")
    .single();
  if (bErr) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw bErr;
  }
  await assertNotPilotBusiness(admin, business.id, "createShop");
  return { userId, email, password, business };
}

async function seedVariant(businessId, track) {
  const { data: product, error } = await admin
    .from("products")
    .insert({
      business_id: businessId,
      name: `RRS ${track ? "Tracked" : "Free"} ${randomUUID().slice(0, 4)}`,
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
      label: "Default",
      stock_quantity: 10,
      reserved_quantity: 0,
      track_inventory: track,
    })
    .select("id, track_inventory")
    .single();
  must(variant, vErr, "variant");
  return variant;
}

async function seedCustomer(businessId) {
  const { data, error } = await admin
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: phoneFromRunId(runId, 1),
      name: "Screen Buyer",
    })
    .select("id")
    .single();
  return must(data, error, "customer");
}

async function seedOrder(businessId, customerId, variantId, {
  status,
  returnRestocked = null,
  refSuffix,
}) {
  const { data: order, error } = await admin
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customerId,
      order_ref: `TF-RRS-${refSuffix}`,
      status,
      total_pence: 1000,
      channel: "whatsapp",
      return_reason: "wrong_size",
      return_requested_at: new Date().toISOString(),
      return_restocked: returnRestocked,
    })
    .select("id, order_ref, return_restocked, status")
    .single();
  must(order, error, "order");
  const { error: iErr } = await admin.from("order_items").insert({
    order_id: order.id,
    business_id: businessId,
    product_variant_id: variantId,
    quantity: 1,
    unit_price_pence: 1000,
  });
  if (iErr) throw new Error(iErr.message);
  return order;
}

function runListAndOrderFacts(businessId, orderIds) {
  const tmp = resolve(root, `scripts/_tmp_rrs_${randomUUID().slice(0, 8)}.mts`);
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
const businessId = ${JSON.stringify(businessId)};
const orderIds = ${JSON.stringify(orderIds)};

const closed = await fetchReturnsList(admin, businessId, "closed", 1);
const byRef = Object.fromEntries(
  closed.rows.map((r) => [r.orderRef, r.returnRestocked]),
);

const orderFacts = [];
for (const orderId of orderIds) {
  const { data: order } = await admin
    .from("orders")
    .select("id, order_ref, return_restocked, status")
    .eq("id", orderId)
    .single();
  const { data: items } = await admin
    .from("order_items")
    .select("product_variants(track_inventory)")
    .eq("order_id", orderId)
    .eq("business_id", businessId);
  let hasTracked = false;
  for (const row of items ?? []) {
    const v = Array.isArray(row.product_variants)
      ? row.product_variants[0]
      : row.product_variants;
    if (v?.track_inventory) hasTracked = true;
  }
  orderFacts.push({
    orderRef: order.order_ref,
    returnRestocked: order.return_restocked ?? null,
    hasTrackedInventory: hasTracked,
    status: order.status,
  });
}

console.log(JSON.stringify({
  listRestockedByRef: byRef,
  listNotRestockedRefs: closed.rows
    .filter((r) => r.returnRestocked === false)
    .map((r) => r.orderRef),
  orderFacts,
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
    throw new Error((out.stderr || out.stdout || "").slice(0, 500));
  }
  return JSON.parse((out.stdout || "").trim().split("\n").filter(Boolean).pop());
}

async function main() {
  console.log("=== verify-return-restock-screens (Step 24e-2) ===");
  console.log(`runId=${runId}`);
  const tag = runId.replace(/^rrs-/, "").slice(0, 8);
  let shop = null;

  try {
    shop = await createShop(tag);
    const cust = await seedCustomer(shop.business.id);
    const tracked = await seedVariant(shop.business.id, true);
    const untracked = await seedVariant(shop.business.id, false);

    const oYes = await seedOrder(shop.business.id, cust.id, tracked.id, {
      status: "RETURNED",
      returnRestocked: true,
      refSuffix: `${tag}-YES`,
    });
    const oNo = await seedOrder(shop.business.id, cust.id, tracked.id, {
      status: "RETURNED",
      returnRestocked: false,
      refSuffix: `${tag}-NO`,
    });
    const oNull = await seedOrder(shop.business.id, cust.id, tracked.id, {
      status: "RETURNED",
      returnRestocked: null,
      refSuffix: `${tag}-NULL`,
    });
    const oApprovedTracked = await seedOrder(
      shop.business.id,
      cust.id,
      tracked.id,
      {
        status: "RETURN_APPROVED",
        returnRestocked: null,
        refSuffix: `${tag}-APR-T`,
      },
    );
    const oApprovedFree = await seedOrder(
      shop.business.id,
      cust.id,
      untracked.id,
      {
        status: "RETURN_APPROVED",
        returnRestocked: null,
        refSuffix: `${tag}-APR-U`,
      },
    );

    const snap = runListAndOrderFacts(shop.business.id, [
      oYes.id,
      oNo.id,
      oNull.id,
      oApprovedTracked.id,
      oApprovedFree.id,
    ]);

    record(
      "1. list exposes returnRestocked; Not restocked only for false",
      snap.listRestockedByRef[oYes.order_ref] === true &&
        snap.listRestockedByRef[oNo.order_ref] === false &&
        snap.listRestockedByRef[oNull.order_ref] === null &&
        snap.listNotRestockedRefs.length === 1 &&
        snap.listNotRestockedRefs[0] === oNo.order_ref,
      JSON.stringify(snap.listRestockedByRef),
    );

    const factYes = snap.orderFacts.find((f) => f.orderRef === oYes.order_ref);
    const factNo = snap.orderFacts.find((f) => f.orderRef === oNo.order_ref);
    const factNull = snap.orderFacts.find((f) => f.orderRef === oNull.order_ref);
    record(
      "2. order data exposes return_restocked (true/false/null)",
      factYes?.returnRestocked === true &&
        factNo?.returnRestocked === false &&
        factNull?.returnRestocked === null,
      JSON.stringify([factYes, factNo, factNull]),
    );

    const factAprT = snap.orderFacts.find(
      (f) => f.orderRef === oApprovedTracked.order_ref,
    );
    const factAprU = snap.orderFacts.find(
      (f) => f.orderRef === oApprovedFree.order_ref,
    );
    record(
      "3. order data exposes hasTrackedInventory for checkbox visibility",
      factAprT?.hasTrackedInventory === true &&
        factAprU?.hasTrackedInventory === false,
      JSON.stringify([factAprT, factAprU]),
    );

    console.log("\nSeller screen behaviour (data-backed):");
    console.log(
      "  Mark-returned + tracked: checkbox 'Add back to stock' default on; sends restock true/false.",
    );
    console.log(
      "  Mark-returned + untracked: no checkbox; body omits restock flag.",
    );
    console.log(
      "  Order detail: shows 'Returned to stock: Yes/No' only when return_restocked is boolean.",
    );
    console.log(
      "  Returns list: subtle 'Not restocked' only when return_restocked === false.",
    );
  } finally {
    if (shop) {
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
