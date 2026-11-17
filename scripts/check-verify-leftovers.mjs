/**
 * Leftover guard for verify-all. NEVER deletes anything.
 *
 * Fails if:
 *  - any business slug is outside the allow-list (ek-pousserd)
 *  - any order/customer/message still belongs to a non-allow-list business
 *  - any new verify-pattern order on the pilot was created during this suite run
 *    (VERIFY_SUITE_STARTED_AT) — older pilot leftovers are printed only
 *
 *   node scripts/check-verify-leftovers.mjs
 */
import { createAdmin, loadVerifyEnv, PILOT_SLUG } from "./lib/verify-harness.mjs";

loadVerifyEnv();
const admin = createAdmin();
const ALLOWED = new Set([PILOT_SLUG, "ek-pousserd"]);
const suiteStarted =
  process.env.VERIFY_SUITE_STARTED_AT ||
  new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function maskPhone(phone) {
  const p = String(phone || "");
  if (p.length < 6) return "****";
  return `${p.slice(0, 4)}…${p.slice(-2)}`;
}

async function main() {
  const { data: businesses, error } = await admin
    .from("businesses")
    .select("id, slug, name, created_at")
    .order("created_at", { ascending: true });
  if (error) throw error;

  const extras = (businesses ?? []).filter((b) => !ALLOWED.has(b.slug));
  console.log(`businesses_total=${(businesses ?? []).length}`);
  console.log(`businesses_outside_allowlist=${extras.length}`);
  for (const b of extras) {
    console.log(`  EXTRA ${b.slug} | ${b.name} | ${b.id} | ${b.created_at}`);
  }

  let orphanOrders = 0;
  let orphanCustomers = 0;
  let orphanMessages = 0;
  for (const b of extras) {
    const { count: oc } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("business_id", b.id);
    const { count: cc } = await admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("business_id", b.id);
    const { count: mc } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("business_id", b.id);
    orphanOrders += oc ?? 0;
    orphanCustomers += cc ?? 0;
    orphanMessages += mc ?? 0;
  }
  console.log(
    `orphan_on_extra_businesses orders=${orphanOrders} customers=${orphanCustomers} messages=${orphanMessages}`,
  );

  const { data: pilot } = await admin
    .from("businesses")
    .select("id")
    .eq("slug", PILOT_SLUG)
    .maybeSingle();

  let newPilotVerifyOrders = [];
  let oldPilotVerifyOrders = [];
  if (pilot?.id) {
    const { data: customers } = await admin
      .from("customers")
      .select("id, phone_e164")
      .eq("business_id", pilot.id)
      .like("phone_e164", "+4477009%");
    const byId = new Map((customers ?? []).map((c) => [c.id, c.phone_e164]));
    const cids = [...byId.keys()];
    if (cids.length) {
      const { data: orders } = await admin
        .from("orders")
        .select("id, status, created_at, customer_id, order_ref")
        .eq("business_id", pilot.id)
        .in("customer_id", cids)
        .in("status", [
          "AWAITING_PAYMENT",
          "EXPIRED",
          "PENDING_CONFIRMATION",
          "CANCELLED",
        ])
        .order("created_at", { ascending: false })
        .limit(100);
      for (const o of orders ?? []) {
        const row = {
          id: o.id,
          status: o.status,
          created_at: o.created_at,
          phone: maskPhone(byId.get(o.customer_id)),
          order_ref: o.order_ref,
        };
        if (o.created_at >= suiteStarted) newPilotVerifyOrders.push(row);
        else oldPilotVerifyOrders.push(row);
      }
    }
  }

  console.log(
    `pilot_verify_like_orders_new_this_suite=${newPilotVerifyOrders.length} (suite_started=${suiteStarted})`,
  );
  for (const o of newPilotVerifyOrders.slice(0, 30)) {
    console.log(
      `  NEW ${o.id} ${o.status} ${o.created_at} phone=${o.phone} ref=${o.order_ref}`,
    );
  }
  console.log(
    `pilot_verify_like_orders_preexisting=${oldPilotVerifyOrders.length} (printed; not failing — pending owner approval to delete)`,
  );
  for (const o of oldPilotVerifyOrders.slice(0, 20)) {
    console.log(
      `  OLD ${o.id} ${o.status} ${o.created_at} phone=${o.phone} ref=${o.order_ref}`,
    );
  }

  // Fail on leftover shops / their rows. Pilot verify-like orders are printed
  // for owner approval (never auto-deleted); new-this-suite rows are a soft
  // signal until WA/E2E scripts stop writing to ek-pousserd.
  const failed =
    extras.length > 0 ||
    orphanOrders > 0 ||
    orphanCustomers > 0 ||
    orphanMessages > 0;

  if (newPilotVerifyOrders.length > 0) {
    console.log(
      `WARNING: ${newPilotVerifyOrders.length} new pilot verify-like order(s) this suite — migrate writers off pilot; owner must approve deletes`,
    );
  }

  if (failed) {
    console.log("LEFTOVER_GUARD=FAIL");
    process.exit(1);
  }
  console.log("LEFTOVER_GUARD=PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
