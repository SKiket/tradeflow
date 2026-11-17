/**
 * Step 23d Part 2 — READ-ONLY classify every order on ek-pousserd.
 * Writes scripts/step23d-delete-group-a-orders.sql (does NOT execute it).
 *
 *   node scripts/step23d-classify-pilot-orders.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdmin, loadVerifyEnv, PILOT_SLUG } from "./lib/verify-harness.mjs";

loadVerifyEnv();
const admin = createAdmin();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MOCK_RE = /^\+447700900\d{3}$/;
/** Explicit verify / fixture order_ref prefixes used across the suite. */
const VERIFY_REF_RE =
  /^TF-(I18N-|S20-|VF-|TEST-|SEED-|RET-|CO-|DSP-|REC|AMEND-|GATE-|WA-)/i;

function maskPhone(phone) {
  const p = String(phone || "");
  if (!p) return "(none)";
  if (p.length <= 3) return `…${p}`;
  return `…${p.slice(-3)}`;
}

function classify(phone, orderRef, channel) {
  const markers = [];
  if (phone && MOCK_RE.test(phone)) markers.push("mock_+447700900xxx");
  // Broader mock-ish Twilio magic / verify range used in suite (+4477009…)
  if (phone && /^\+4477009/.test(phone) && !MOCK_RE.test(phone)) {
    markers.push("mock_adjacent_+4477009");
  }
  if (orderRef && VERIFY_REF_RE.test(orderRef)) {
    markers.push(`ref_${String(orderRef).split("-").slice(0, 2).join("-")}`);
  }
  if (
    orderRef &&
    /^TF-[0-9A-F]{8}$/i.test(orderRef) &&
    phone &&
    /^\+4477009/.test(phone)
  ) {
    markers.push("hex_ref_plus_mockish_phone");
  }

  const hasVerifyMarker =
    (phone && MOCK_RE.test(phone)) ||
    (phone && /^\+4477009/.test(phone)) ||
    (orderRef && VERIFY_REF_RE.test(orderRef));

  // A: mock phone or verify marker (clearly script data)
  // B: real-looking phone (any other number), even if ref looks generic
  // C: no phone and no verify marker
  let group;
  if (phone && !/^\+4477009/.test(phone) && !MOCK_RE.test(phone)) {
    group = "B";
  } else if (hasVerifyMarker) {
    group = "A";
  } else if (!phone) {
    group = "C";
  } else {
    group = "A";
  }
  return { group, markers: markers.join(",") || "-" };
}

async function main() {
  const { data: pilot, error: pErr } = await admin
    .from("businesses")
    .select("id, slug")
    .eq("slug", PILOT_SLUG)
    .single();
  if (pErr) throw pErr;

  const { data: customers } = await admin
    .from("customers")
    .select("id, phone_e164")
    .eq("business_id", pilot.id);
  const phoneById = new Map((customers ?? []).map((c) => [c.id, c.phone_e164]));

  // Paginate all orders
  const orders = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await admin
      .from("orders")
      .select(
        "id, status, created_at, customer_id, order_ref, channel, stripe_payment_intent_id, stripe_checkout_session_id, thread_id, total_pence",
      )
      .eq("business_id", pilot.id)
      .order("created_at", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    orders.push(...(data ?? []));
    if (!data || data.length < page) break;
    from += page;
  }

  console.log(`=== Pilot ${PILOT_SLUG} orders: ${orders.length} ===`);
  console.log(
    "id\tstatus\tcreated_at\tphone_mask\tmock900\tchannel\tmarkers\tgroup\tref",
  );

  const groups = { A: [], B: [], C: [] };
  for (const o of orders) {
    const phone = phoneById.get(o.customer_id) || null;
    const { group, markers } = classify(phone, o.order_ref, o.channel);
    const row = {
      ...o,
      phone,
      markers,
      group,
      channel: o.channel || "(null)",
    };
    groups[group].push(row);
    console.log(
      [
        o.id,
        o.status,
        o.created_at,
        maskPhone(phone),
        phone && MOCK_RE.test(phone) ? "Y" : "N",
        row.channel,
        markers,
        group,
        o.order_ref ?? "",
      ].join("\t"),
    );
  }

  console.log("\n=== COUNTS ===");
  console.log(`A (mock/verify)=${groups.A.length}`);
  console.log(`B (real-looking phone)=${groups.B.length}`);
  console.log(`C (no phone / unknown)=${groups.C.length}`);

  console.log("\n=== GROUP B (full phones) ===");
  for (const r of groups.B) {
    console.log(
      `${r.id}\t${r.status}\t${r.created_at}\t${r.phone}\t${r.channel}\t${r.order_ref}`,
    );
  }
  console.log("\n=== GROUP C ===");
  for (const r of groups.C) {
    console.log(
      `${r.id}\t${r.status}\t${r.created_at}\tphone=${r.phone ?? "null"}\t${r.channel}\t${r.order_ref}\t${r.markers}`,
    );
  }

  // Linked payments / refunds / messages for group A
  const aIds = groups.A.map((r) => r.id);
  const aCustomerIds = [
    ...new Set(groups.A.map((r) => r.customer_id).filter(Boolean)),
  ];
  let refunds = [];
  let messages = [];
  if (aIds.length) {
    // chunk in 100s
    for (let i = 0; i < aIds.length; i += 100) {
      const chunk = aIds.slice(i, i + 100);
      const { data: rf } = await admin
        .from("order_refunds")
        .select(
          "id, order_id, stripe_refund_id, amount_pence, created_at",
        )
        .in("order_id", chunk);
      refunds.push(...(rf ?? []));
    }
  }
  if (aCustomerIds.length) {
    for (let i = 0; i < aCustomerIds.length; i += 100) {
      const chunk = aCustomerIds.slice(i, i + 100);
      const { data: msgs } = await admin
        .from("messages")
        .select("id, customer_id, direction, created_at, order_id")
        .eq("business_id", pilot.id)
        .in("customer_id", chunk)
        .limit(5000);
      messages.push(...(msgs ?? []));
    }
  }

  const withPi = groups.A.filter((r) => r.stripe_payment_intent_id);
  const withCs = groups.A.filter((r) => r.stripe_checkout_session_id);

  console.log("\n=== GROUP A linked ===");
  console.log(`order_refunds=${refunds.length}`);
  console.log(`messages_on_A_customers=${messages.length}`);
  console.log(`orders_with_payment_intent=${withPi.length}`);
  console.log(`orders_with_checkout_session=${withCs.length}`);
  console.log("Stripe objects (test mode) referenced by group A:");
  for (const r of withPi.slice(0, 50)) {
    console.log(`  pi ${r.stripe_payment_intent_id} order=${r.id} ref=${r.order_ref}`);
  }
  if (withPi.length > 50) console.log(`  … +${withPi.length - 50} more PIs`);
  for (const r of withCs.slice(0, 30)) {
    console.log(
      `  cs ${r.stripe_checkout_session_id} order=${r.id} ref=${r.order_ref}`,
    );
  }
  if (withCs.length > 30) console.log(`  … +${withCs.length - 30} more CS`);
  for (const rf of refunds) {
    console.log(
      `  refund ${rf.stripe_refund_id ?? "(null)"} order=${rf.order_id} amount=${rf.amount_pence}`,
    );
  }

  // Write delete SQL — NOT executed
  const sqlPath = resolve(root, "scripts/step23d-delete-group-a-orders.sql");
  const idList = aIds.map((id) => `'${id}'`).join(",\n  ");
  const custList = aCustomerIds.map((id) => `'${id}'`).join(",\n  ");
  const sql = `-- Step 23d — PROPOSED delete for group A (mock/verify) orders on ek-pousserd ONLY.
-- DO NOT RUN until owner approves. Read-only classification generated this file.
-- Pilot business slug: ek-pousserd
-- Group A order count: ${aIds.length}
-- Group A customer count: ${aCustomerIds.length}
-- Generated: ${new Date().toISOString()}

BEGIN;

-- Scope guard: abort if any listed order is not on ek-pousserd
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM public.orders o
  JOIN public.businesses b ON b.id = o.business_id
  WHERE o.id IN (
  ${idList || "NULL"}
  )
  AND b.slug <> 'ek-pousserd';
  IF bad > 0 THEN
    RAISE EXCEPTION 'Refusing delete: % orders not on ek-pousserd', bad;
  END IF;
END $$;

-- 1) Refunds for group A orders
DELETE FROM public.order_refunds
WHERE order_id IN (
  ${idList || "NULL"}
);

-- 2) Fraud / disputes pointing at these orders
DELETE FROM public.fraud_warnings
WHERE order_id IN (
  ${idList || "NULL"}
);

UPDATE public.disputes
SET order_id = NULL
WHERE order_id IN (
  ${idList || "NULL"}
);

-- 3) Order children
DELETE FROM public.order_items
WHERE order_id IN (
  ${idList || "NULL"}
);

DELETE FROM public.order_status_history
WHERE order_id IN (
  ${idList || "NULL"}
);

-- 4) Messages tied to these orders (if order_id set)
DELETE FROM public.messages
WHERE order_id IN (
  ${idList || "NULL"}
);

-- 5) Orders themselves
DELETE FROM public.orders
WHERE id IN (
  ${idList || "NULL"}
);

-- 6) Optional: messages for mock customers that have ZERO remaining orders
-- (commented — review before enabling; may remove live thread history if misclassified)
-- DELETE FROM public.messages
-- WHERE business_id = (SELECT id FROM public.businesses WHERE slug = 'ek-pousserd')
--   AND customer_id IN (
--   ${custList || "NULL"}
--   )
--   AND NOT EXISTS (
--     SELECT 1 FROM public.orders o WHERE o.customer_id = messages.customer_id
--   );

-- 7) Optional: customers with no remaining orders (commented)
-- DELETE FROM public.customers c
-- WHERE c.business_id = (SELECT id FROM public.businesses WHERE slug = 'ek-pousserd')
--   AND c.id IN (
--   ${custList || "NULL"}
--   )
--   AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.customer_id = c.id);

COMMIT;

-- NOTE: Stripe PaymentIntents / Checkout Sessions / Refunds in TEST mode are NOT
-- deleted by this SQL. Cancel/refund in Stripe Dashboard (test) if needed.
-- PIs referenced: ${withPi.length}
-- Checkout sessions referenced: ${withCs.length}
-- DB refunds: ${refunds.length}
`;

  writeFileSync(sqlPath, sql, "utf8");
  console.log(`\nWrote ${sqlPath} (NOT executed)`);
  console.log("\n=== SQL FILE BEGIN ===");
  console.log(sql);
  console.log("=== SQL FILE END ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
