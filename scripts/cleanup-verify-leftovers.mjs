/**
 * List and delete leftover verify/test rows. Never touches pilot shop EK-Pousser_D
 * or businesses without a test marker.
 *
 *   node scripts/cleanup-verify-leftovers.mjs           # list only
 *   node scripts/cleanup-verify-leftovers.mjs --delete  # delete listed rows
 */
import { createAdmin, loadVerifyEnv } from "./lib/verify-harness.mjs";

loadVerifyEnv();
const admin = createAdmin();
const doDelete = process.argv.includes("--delete");

const PILOT_NAMES = new Set(["EK-Pousser_D"]);
const TEST_SLUG_RE =
  /^(pk-|pd-|desc-|csv-|vf-|test-|tmp-|multi-|bill-|billing-|rls-|imp-|ag-|gate-|conn-|wa-|tenant-a$|tenant-b$|inbox-other-|step19-)/i;
const TEST_NAME_RE =
  /(PK Shop|PD Shop|Describe Shop|CSV Import|Verify |Test Shop|tmp-|Billing (trial|active|Enf)|AG Shop|Connect Gate|WA Cart|Tenant [AB]|Inbox Other|Step19)/i;
const TEST_EMAIL_RE =
  /@(example\.com|tradeflow-test\.local)$/i;
const TEST_PHONE_RE = /^\+4477009\d{5}$/; // mock range used by verifies

function isTestBusiness(b) {
  if (PILOT_NAMES.has(b.name)) return false;
  if (TEST_SLUG_RE.test(b.slug || "")) return true;
  if (TEST_NAME_RE.test(b.name || "")) return true;
  return false;
}

async function deleteOrdersForBusiness(businessId) {
  const { data: orders } = await admin
    .from("orders")
    .select("id")
    .eq("business_id", businessId);
  const ids = (orders ?? []).map((o) => o.id);
  if (!ids.length) return 0;
  await admin.from("order_refunds").delete().in("order_id", ids);
  await admin.from("fraud_warnings").delete().in("order_id", ids);
  await admin.from("disputes").update({ order_id: null }).in("order_id", ids);
  await admin.from("order_items").delete().in("order_id", ids);
  await admin.from("order_status_history").delete().in("order_id", ids);
  await admin.from("orders").delete().in("id", ids);
  return ids.length;
}

async function main() {
  const { data: businesses, error } = await admin
    .from("businesses")
    .select("id, name, slug, owner_user_id, deleted_at")
    .is("deleted_at", null);
  if (error) throw error;

  const testBiz = (businesses ?? []).filter(isTestBusiness);
  console.log("=== Leftover test businesses (candidates) ===");
  console.log(`count=${testBiz.length}`);
  for (const b of testBiz) {
    console.log(`  ${b.slug} | ${b.name} | ${b.id}`);
  }

  // Orphan PENDING drafts on pilot for mock phones (empty items etc.)
  const { data: pilot } = await admin
    .from("businesses")
    .select("id")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();

  let orphanPending = [];
  if (pilot) {
    const { data: customers } = await admin
      .from("customers")
      .select("id, phone_e164")
      .eq("business_id", pilot.id)
      .or(
        "phone_e164.like.+4477009%,phone_e164.eq.+447733308706,phone_e164.eq.+447700900093",
      );
    const cids = (customers ?? []).map((c) => c.id);
    if (cids.length) {
      const { data: pending } = await admin
        .from("orders")
        .select("id, order_ref, status, customer_id, total_pence")
        .eq("business_id", pilot.id)
        .eq("status", "PENDING_CONFIRMATION")
        .in("customer_id", cids);
      orphanPending = pending ?? [];
    }
  }
  console.log(
    `\n=== Pilot orphan PENDING_CONFIRMATION (test phones) ===\ncount=${orphanPending.length}`,
  );

  // Soft-deleted seed products without active twins are fine; report soft-deleted tagged
  const { count: softSeed } = await admin
    .from("products")
    .select("id", { count: "exact", head: true })
    .ilike("description", "%[order_parse_seed]%")
    .not("deleted_at", "is", null);
  console.log(`\nSoft-deleted seed-tagged products: ${softSeed ?? 0}`);

  if (!doDelete) {
    console.log("\nDry run only. Re-run with --delete to remove candidates.");
    return;
  }

  let deletedBiz = 0;
  let deletedOrders = 0;
  let deletedUsers = 0;
  let deletedPending = 0;

  for (const b of testBiz) {
    deletedOrders += await deleteOrdersForBusiness(b.id);
    for (const table of [
      "ai_knowledge_gaps",
      "ai_describe_usage",
      "analytics_cache",
      "pending_replays",
      "messages",
      "product_images",
      "product_variants",
      "products",
      "customers",
      "disputes",
      "fraud_warnings",
    ]) {
      const { error } = await admin.from(table).delete().eq("business_id", b.id);
      if (error && !/schema cache|does not exist/i.test(error.message)) {
        console.warn(`  ${b.slug} ${table}: ${error.message}`);
      }
    }
    const { error: delBiz } = await admin
      .from("businesses")
      .delete()
      .eq("id", b.id);
    if (!delBiz) deletedBiz += 1;
    if (b.owner_user_id) {
      const { error: delUser } = await admin.auth.admin.deleteUser(
        b.owner_user_id,
      );
      if (!delUser) deletedUsers += 1;
    }
  }

  if (orphanPending.length) {
    const ids = orphanPending.map((o) => o.id);
    await admin.from("order_refunds").delete().in("order_id", ids);
    await admin.from("order_items").delete().in("order_id", ids);
    await admin.from("order_status_history").delete().in("order_id", ids);
    await admin.from("orders").delete().in("id", ids);
    deletedPending = ids.length;
  }

  console.log("\n=== Deleted ===");
  console.log(
    JSON.stringify(
      {
        testBusinesses: deletedBiz,
        ordersFromTestBiz: deletedOrders,
        authUsers: deletedUsers,
        pilotOrphanPending: deletedPending,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
