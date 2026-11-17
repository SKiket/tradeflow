/**
 * Step 23d Part 1 — delete exact-slug leftover test shops only.
 * Never touches ek-pousserd. Cancels unique Stripe TEST subscriptions when present;
 * leaves shared Connect accounts alone.
 *
 *   node scripts/step23d-purge-exact-shops.mjs
 */
import Stripe from "stripe";
import { createAdmin, loadVerifyEnv, PILOT_SLUG } from "./lib/verify-harness.mjs";

loadVerifyEnv();
const admin = createAdmin();

const SLUGS = [
  "pk-shop-mwksq2vk-75c",
  "ag-j-563678",
  "billing-trial-1794926532937-zipa",
  "billing-active-1794926552874-5tzl",
  "billing-enf-1794926583001-sybe",
];

const TABLES = [
  "deletion_requests",
  "order_refunds",
  "disputes",
  "fraud_warnings",
  "order_items",
  "order_status_history",
  "orders",
  "messages",
  "pending_replays",
  "ai_knowledge_gaps",
  "ai_describe_usage",
  "analytics_cache",
  "broadcasts",
  "message_templates",
  "product_images",
  "product_variants",
  "products",
  "customers",
];

async function countEq(table, col, val) {
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(col, val);
  if (error && !/schema cache|does not exist/i.test(error.message)) {
    console.warn(`count ${table}: ${error.message}`);
  }
  return count ?? 0;
}

async function removeStorageForBusiness(businessId) {
  let removed = 0;
  for (const bucket of ["product-images", "business-branding"]) {
    try {
      const { data: listed } = await admin.storage.from(bucket).list(businessId, {
        limit: 100,
      });
      const paths = (listed ?? [])
        .filter((f) => f.name)
        .map((f) => `${businessId}/${f.name}`);
      if (paths.length) {
        const { error } = await admin.storage.from(bucket).remove(paths);
        if (!error) removed += paths.length;
        else console.warn(`storage ${bucket}: ${error.message}`);
      }
    } catch (e) {
      console.warn(`storage ${bucket}: ${e.message}`);
    }
  }
  return removed;
}

async function handleStripe(biz, stripe) {
  const report = {
    slug: biz.slug,
    stripe_connected_account_id: biz.stripe_connected_account_id,
    stripe_customer_id: biz.stripe_customer_id,
    stripe_subscription_id: biz.stripe_subscription_id,
    stripe_subscription_status: biz.stripe_subscription_status,
    action: "none",
  };
  if (!stripe) {
    report.action = "skipped_no_stripe_key";
    return report;
  }
  // Shared Connect fixture used by pilot verifies — never delete/cancel the account.
  if (biz.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(biz.stripe_subscription_id);
      if (sub.status !== "canceled") {
        await stripe.subscriptions.cancel(biz.stripe_subscription_id);
        report.action = `canceled_subscription ${biz.stripe_subscription_id} (was ${sub.status})`;
      } else {
        report.action = `subscription_already_canceled ${biz.stripe_subscription_id}`;
      }
    } catch (e) {
      report.action = `subscription_cancel_error: ${e.message}`;
    }
  } else if (biz.stripe_connected_account_id || biz.stripe_customer_id) {
    report.action =
      "left_in_place (no unique subscription to cancel; Connect/customer left — Connect may be shared)";
  }
  return report;
}

async function deleteBusiness(b, stripe) {
  if (b.slug === PILOT_SLUG || b.name === "EK-Pousser_D") {
    throw new Error("Refusing pilot");
  }
  const stripeReport = await handleStripe(b, stripe);
  const counts = {};
  for (const t of TABLES) {
    counts[t] = await countEq(t, "business_id", b.id);
  }

  const { data: orders } = await admin
    .from("orders")
    .select("id")
    .eq("business_id", b.id);
  const oids = (orders ?? []).map((o) => o.id);
  if (oids.length) {
    await admin.from("order_refunds").delete().in("order_id", oids);
    await admin.from("fraud_warnings").delete().in("order_id", oids);
    await admin.from("disputes").update({ order_id: null }).in("order_id", oids);
    await admin.from("order_items").delete().in("order_id", oids);
    await admin.from("order_status_history").delete().in("order_id", oids);
    await admin.from("orders").delete().in("id", oids);
  }

  for (const t of TABLES) {
    if (
      t === "orders" ||
      t === "order_items" ||
      t === "order_status_history" ||
      t === "order_refunds"
    ) {
      continue;
    }
    const { error } = await admin.from(t).delete().eq("business_id", b.id);
    if (error && !/schema cache|does not exist/i.test(error.message)) {
      console.warn(`delete ${t}: ${error.message}`);
    }
  }

  const storageRemoved = await removeStorageForBusiness(b.id);
  await admin.from("businesses").delete().eq("id", b.id);
  let userDeleted = 0;
  if (b.owner_user_id) {
    const { error } = await admin.auth.admin.deleteUser(b.owner_user_id);
    if (!error) userDeleted = 1;
  }
  return {
    counts,
    userDeleted,
    ordersDeleted: oids.length,
    storageRemoved,
    stripeReport,
  };
}

async function main() {
  for (const s of SLUGS) {
    if (s === PILOT_SLUG) throw new Error("pilot in list");
  }

  const key = process.env.STRIPE_SECRET_KEY || "";
  if (key && !key.startsWith("sk_test_")) {
    throw new Error("Refusing Stripe ops: STRIPE_SECRET_KEY is not sk_test_");
  }
  const stripe = key
    ? new Stripe(key, { apiVersion: "2026-06-24.dahlia" })
    : null;

  console.log("=== Step 23d exact-slug deletes ===");
  console.log(`Stripe mode: ${key ? "TEST (sk_test_)" : "no key"}`);
  const totals = {};
  const stripeReports = [];

  for (const slug of SLUGS) {
    const { data: b, error } = await admin
      .from("businesses")
      .select(
        "id, slug, name, owner_user_id, stripe_connected_account_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_status",
      )
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    if (!b) {
      console.log(`MISSING slug=${slug} (already gone)`);
      continue;
    }
    console.log(`\nDeleting ${b.slug} (${b.name}) ${b.id}`);
    console.log(
      `  stripe: acct=${b.stripe_connected_account_id} cus=${b.stripe_customer_id} sub=${b.stripe_subscription_id} status=${b.stripe_subscription_status}`,
    );
    const r = await deleteBusiness(b, stripe);
    stripeReports.push(r.stripeReport);
    for (const [k, v] of Object.entries(r.counts)) {
      totals[k] = (totals[k] ?? 0) + v;
    }
    totals.businesses = (totals.businesses ?? 0) + 1;
    totals.auth_users = (totals.auth_users ?? 0) + r.userDeleted;
    totals.storage_objects = (totals.storage_objects ?? 0) + r.storageRemoved;
    console.log(
      `  orders_deleted=${r.ordersDeleted} user_deleted=${r.userDeleted} storage=${r.storageRemoved}`,
    );
    console.log(`  pre-delete counts: ${JSON.stringify(r.counts)}`);
    console.log(`  stripe_action: ${r.stripeReport.action}`);
  }

  console.log("\n=== STRIPE REPORT ===");
  console.log(JSON.stringify(stripeReports, null, 2));
  console.log("\n=== TOTALS (rows present before delete) ===");
  console.log(JSON.stringify(totals, null, 2));

  const { data: left } = await admin
    .from("businesses")
    .select("slug, name")
    .order("created_at", { ascending: true });
  console.log("\n=== businesses AFTER ===");
  for (const row of left ?? []) console.log(`${row.slug}\t${row.name}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
