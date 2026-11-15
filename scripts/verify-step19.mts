/**
 * Step 19 — data deletion / export verification (test data; no real Twilio sends).
 *
 *   npx --yes tsx scripts/verify-step19.mts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { authorizeCronRequest } from "../src/lib/cron/auth.ts";
import {
  canEraseCustomer,
  eraseCustomer,
  ERASURE_BLOCKING_STATUSES,
} from "../src/lib/privacy/erase-customer.ts";
import { RETAINED_RECORD_YEARS } from "../src/lib/privacy/constants.ts";
import { canAcceptOrders } from "../src/lib/stripe/billing-gate.ts";
import { ORDER_STATUS } from "../src/lib/orders/status.ts";
import { fetchPublicTrackingOrder } from "../src/lib/tracking/public-order.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env: Record<string, string> = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, eq)] = v;
  }
  return env;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function withEnvAsync(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  const fileEnv = loadEnv();
  for (const [k, v] of Object.entries(fileEnv)) {
    if (process.env[k] == null) process.env[k] = v;
  }

  console.log("=== Step 19 verification ===");
  console.log("RETAINED_RECORD_YEARS =", RETAINED_RECORD_YEARS);
  console.log("Stripe disputes tracked: NO (not in schema/webhooks)\n");

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `step19-${suffix}@tradeflow-test.local`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: `Test19!${suffix}`,
    email_confirm: true,
  });
  assert(!userError && userData.user, `create user: ${userError?.message}`);
  const ownerId = userData.user!.id;

  const slug = `step19-${suffix}`;
  const { data: business, error: bizError } = await admin
    .from("businesses")
    .insert({
      owner_user_id: ownerId,
      slug,
      name: `Step19 Shop ${suffix}`,
      stripe_subscription_status: "trialing",
    })
    .select("id")
    .single();
  assert(!bizError && business, `create business: ${bizError?.message}`);
  const businessId = business!.id as string;

  const phone = `+447700900${String(100 + (parseInt(suffix.slice(0, 2), 16) % 800)).padStart(3, "0")}`;
  const { data: customer, error: custError } = await admin
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: phone,
      name: "Step19 Buyer",
      notes: "secret note",
      addresses: [{ line1: "1 Test Street" }],
    })
    .select("id")
    .single();
  assert(!custError && customer, `create customer: ${custError?.message}`);
  const customerId = customer!.id as string;

  const { data: product } = await admin
    .from("products")
    .insert({
      business_id: businessId,
      name: "Step19 Soap",
      price_pence: 500,
      active: true,
    })
    .select("id")
    .single();
  const { data: variant } = await admin
    .from("product_variants")
    .insert({
      business_id: businessId,
      product_id: product!.id,
      label: "Standard",
      stock_quantity: 10,
      track_inventory: true,
    })
    .select("id")
    .single();

  const orderRef = `TF-S19-${suffix.toUpperCase()}`;
  const { data: order } = await admin
    .from("orders")
    .insert({
      business_id: businessId,
      customer_id: customerId,
      channel: "whatsapp",
      status: ORDER_STATUS.DELIVERED,
      total_pence: 500,
      order_ref: orderRef,
      notes: "leave at door — Jane",
      shipping_address: {
        line1: "12 High Street",
        city: "London",
        postcode: "E1 1AA",
        country: "GB",
      },
      return_reason: "changed_mind",
      return_notes: "buyer said too big",
    })
    .select("id")
    .single();

  await admin.from("order_items").insert({
    order_id: order!.id,
    business_id: businessId,
    product_variant_id: variant!.id,
    quantity: 1,
    unit_price_pence: 500,
  });

  await admin.from("order_refunds").insert({
    order_id: order!.id,
    business_id: businessId,
    stripe_refund_id: `re_test_${suffix}`,
    amount_pence: 0,
    status: "succeeded",
    reason: "customer asked politely",
    prior_order_status: ORDER_STATUS.DELIVERED,
  });

  await admin.from("messages").insert({
    business_id: businessId,
    customer_id: customerId,
    channel: "whatsapp",
    direction: "inbound",
    normalised_text: "I want soap please",
    raw_payload: { Body: "I want soap please", From: phone },
    thread_id: randomUUID(),
  });

  // Blocked erase while PAID
  await admin
    .from("orders")
    .update({ status: ORDER_STATUS.PAID })
    .eq("id", order!.id);
  const blockedPaid = await canEraseCustomer(admin, businessId, customerId);
  assert(!blockedPaid.ok, "erase blocked for PAID");
  console.log("OK erase blocked for paid-unfulfilled");

  await admin
    .from("orders")
    .update({ status: ORDER_STATUS.REFUND_PENDING })
    .eq("id", order!.id);
  const blockedRefund = await canEraseCustomer(admin, businessId, customerId);
  assert(!blockedRefund.ok, "erase blocked for REFUND_PENDING");
  console.log("OK erase blocked for refund in progress");

  await admin
    .from("orders")
    .update({ status: ORDER_STATUS.DELIVERED })
    .eq("id", order!.id);

  const erase1 = await eraseCustomer(admin, {
    businessId,
    customerId,
    requestedBy: "operator",
  });
  assert(erase1.ok, "erase succeeds");
  if (erase1.ok) {
    assert(erase1.counts.messagesDeleted >= 1, "messages deleted");
    assert(erase1.counts.ordersAnonymised >= 1, "orders anonymised");
    assert(erase1.counts.customerAnonymised === 1, "customer anonymised");
  }
  console.log("OK eraseCustomer first run");

  const { data: anonCustomer } = await admin
    .from("customers")
    .select("name, phone_e164, notes, deleted_at")
    .eq("id", customerId)
    .single();
  assert(anonCustomer?.name === "Deleted customer", "name anonymised");
  assert(
    String(anonCustomer?.phone_e164).startsWith("deleted-"),
    "phone is random placeholder not hash",
  );
  assert(anonCustomer?.notes == null, "notes cleared");
  assert(anonCustomer?.deleted_at, "deleted_at set");

  const { data: anonOrder } = await admin
    .from("orders")
    .select(
      "notes, shipping_address, return_notes, return_reason, anonymised_at, total_pence, status, order_ref",
    )
    .eq("id", order!.id)
    .single();
  assert(anonOrder?.anonymised_at, "anonymised_at set");
  assert(anonOrder?.notes == null, "order notes cleared");
  assert(anonOrder?.shipping_address == null, "shipping cleared");
  assert(anonOrder?.return_notes == null, "return notes cleared");
  assert(anonOrder?.total_pence === 500, "total retained");
  assert(anonOrder?.status === ORDER_STATUS.DELIVERED, "status retained");

  const { data: refund } = await admin
    .from("order_refunds")
    .select("reason, stripe_refund_id, amount_pence")
    .eq("order_id", order!.id)
    .maybeSingle();
  assert(refund?.reason == null, "refund reason cleared");
  assert(refund?.stripe_refund_id, "stripe_refund_id kept");

  const { count: msgLeft } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId);
  assert((msgLeft ?? 0) === 0, "messages gone");

  const erase2 = await eraseCustomer(admin, {
    businessId,
    customerId,
    requestedBy: "operator",
  });
  assert(erase2.ok, "second erase harmless");
  console.log("OK erase idempotent");

  const publicOrder = await fetchPublicTrackingOrder(orderRef);
  assert(publicOrder, "public tracking loads");
  const publicJson = JSON.stringify(publicOrder);
  assert(!publicJson.includes("Jane"), "public tracking no buyer name");
  assert(!publicJson.includes("12 High Street"), "public tracking no address");
  assert(!publicJson.includes(phone), "public tracking no phone");
  assert(publicOrder!.totalPence === 500, "public total intact");
  console.log("OK public tracking after anonymisation shows no PII");

  assert(
    !canAcceptOrders({
      stripe_subscription_status: "trialing",
      closed_at: new Date().toISOString(),
    }),
    "closed shop cannot accept orders",
  );
  console.log("OK closed shop blocks canAcceptOrders");

  assert(
    ERASURE_BLOCKING_STATUSES.includes(ORDER_STATUS.AWAITING_PAYMENT),
    "blocking list includes unpaid-active",
  );

  const { data: delReq } = await admin
    .from("deletion_requests")
    .select("id, counts, subject_id, subject_type")
    .eq("subject_id", customerId)
    .eq("status", "completed")
    .limit(1)
    .maybeSingle();
  assert(delReq, "deletion_request recorded");
  const countsJson = JSON.stringify(delReq!.counts);
  assert(!countsJson.includes(phone), "deletion_requests has no phone");
  assert(!countsJson.includes("Step19 Buyer"), "deletion_requests has no name");
  console.log("OK deletion_requests accountability (no PII)");

  await withEnvAsync({ CRON_SHARED_SECRET: undefined }, async () => {
    const fakeReq = {
      headers: { get: () => "x" },
      nextUrl: { searchParams: new URLSearchParams() },
    } as unknown as import("next/server").NextRequest;
    assert(
      !(await authorizeCronRequest(fakeReq)),
      "shop-purge cron fail-closed when secret unset",
    );
  });
  console.log("OK cron fail-closed when secret unset");

  // Cleanup test shop data (keep auth user delete)
  await admin.from("order_refunds").delete().eq("business_id", businessId);
  await admin.from("order_items").delete().eq("business_id", businessId);
  await admin.from("order_status_history").delete().eq("business_id", businessId);
  await admin.from("orders").delete().eq("business_id", businessId);
  await admin.from("messages").delete().eq("business_id", businessId);
  await admin.from("pending_replays").delete().eq("business_id", businessId);
  await admin.from("customers").delete().eq("business_id", businessId);
  await admin.from("product_variants").delete().eq("business_id", businessId);
  await admin.from("products").delete().eq("business_id", businessId);
  await admin.from("deletion_requests").delete().eq("business_id", businessId);
  await admin.from("businesses").delete().eq("id", businessId);
  await admin.auth.admin.deleteUser(ownerId);

  console.log("\nALL STEP 19 CHECKS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
