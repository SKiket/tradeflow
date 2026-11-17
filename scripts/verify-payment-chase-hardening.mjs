/**
 * Step 23b — payment-chase no_channel skip + send-fail retry cap.
 *   TWILIO_DRY_RUN=true node scripts/verify-payment-chase-hardening.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createAdmin,
  deleteTestBusiness,
  loadVerifyEnv,
  newRunId,
  phoneFromRunId,
} from "./lib/verify-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadVerifyEnv();
process.env.TWILIO_DRY_RUN = "true";

const admin = createAdmin();
const BASE = process.env.BASE_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SHARED_SECRET;
const runId = newRunId("pch");
let shopSeq = 0;
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

async function postCron() {
  const res = await fetch(`${BASE}/api/cron/payment-chase`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
    },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function provisionShop({ withWhatsApp }) {
  shopSeq += 1;
  const stamp = `${Date.now()}-${shopSeq}`;
  const email = `pch-${stamp}@tradeflow-test.local`;
  const password = `Pch-${randomUUID().slice(0, 10)}!aA1`;
  const { data: userData, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr) throw userErr;
  const userId = userData.user.id;
  const shopPhone = withWhatsApp
    ? phoneFromRunId(`${runId}-shop-${shopSeq}`)
    : null;
  const { data: biz, error: bizErr } = await admin
    .from("businesses")
    .insert({
      owner_user_id: userId,
      name: `Billing trial ${stamp}-pch`,
      slug: `billing-trial-${stamp}-pch`,
      whatsapp_phone_e164: shopPhone,
      stripe_subscription_status: "trialing",
      trial_ends_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      stripe_charges_enabled: true,
      stripe_transfers_capability_active: true,
    })
    .select("id")
    .single();
  const business = must(biz, bizErr, "business insert");

  const { data: product, error: productErr } = await admin
    .from("products")
    .insert({
      business_id: business.id,
      name: "Chase Mug",
      description: "test",
      price_pence: 500,
      active: true,
    })
    .select("id")
    .single();
  const productRow = must(product, productErr, "product insert");
  const { data: variant, error: variantErr } = await admin
    .from("product_variants")
    .insert({
      product_id: productRow.id,
      business_id: business.id,
      label: "Std",
      stock_quantity: 5,
      track_inventory: true,
    })
    .select("id")
    .single();
  const variantRow = must(variant, variantErr, "variant insert");

  const buyerPhone = phoneFromRunId(`${runId}-buyer-${shopSeq}`);
  const { data: customer, error: customerErr } = await admin
    .from("customers")
    .insert({
      business_id: business.id,
      phone_e164: buyerPhone,
      name: "Chase Buyer",
    })
    .select("id")
    .single();
  const customerRow = must(customer, customerErr, "customer insert");

  const orderRef = `TF-PCH-${stamp.slice(-10).toUpperCase()}`;
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      business_id: business.id,
      customer_id: customerRow.id,
      order_ref: orderRef,
      status: "AWAITING_PAYMENT",
      channel: "storefront",
      total_pence: 500,
      reserved_until: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    })
    .select("id, order_ref")
    .single();
  const orderRow = must(order, orderErr, "order insert");

  const awaitingSince = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  const { error: histErr } = await admin.from("order_status_history").insert({
    order_id: orderRow.id,
    business_id: business.id,
    from_status: "PENDING_CONFIRMATION",
    to_status: "AWAITING_PAYMENT",
    changed_at: awaitingSince,
  });
  if (histErr) throw new Error(`history insert: ${histErr.message}`);

  const { error: itemErr } = await admin.from("order_items").insert({
    order_id: orderRow.id,
    business_id: business.id,
    product_variant_id: variantRow.id,
    quantity: 1,
    unit_price_pence: 500,
  });
  if (itemErr) throw new Error(`item insert: ${itemErr.message}`);

  return {
    businessId: business.id,
    userId,
    orderId: orderRow.id,
    orderRef: orderRow.order_ref,
    withWhatsApp,
  };
}

async function main() {
  if (!SECRET) throw new Error("CRON_SHARED_SECRET missing");
  console.log(`runId=${runId}`);
  const shops = [];

  try {
    const noWa = await provisionShop({ withWhatsApp: false });
    shops.push(noWa);

    const cron1 = await postCron();
    const { data: after1 } = await admin
      .from("orders")
      .select(
        "payment_reminder_12h_sent_at, payment_reminder_12h_outcome, payment_reminder_12h_attempts",
      )
      .eq("id", noWa.orderId)
      .single();

    record(
      "no WhatsApp shop: 12h reminder skipped_no_channel, claim kept",
      cron1.status === 200 &&
        cron1.json.ok === true &&
        after1.payment_reminder_12h_outcome === "skipped_no_channel" &&
        Boolean(after1.payment_reminder_12h_sent_at),
      `http=${cron1.status} outcome=${after1.payment_reminder_12h_outcome} sent_at=${after1.payment_reminder_12h_sent_at} counts=${JSON.stringify(cron1.json.counts)}`,
    );

    const cron2 = await postCron();
    const { data: after2 } = await admin
      .from("orders")
      .select("payment_reminder_12h_outcome, payment_reminder_12h_attempts")
      .eq("id", noWa.orderId)
      .single();
    record(
      "second run does not re-attempt skipped no_channel",
      cron2.status === 200 &&
        cron2.json.ok === true &&
        after2.payment_reminder_12h_outcome === "skipped_no_channel" &&
        (after2.payment_reminder_12h_attempts ?? 0) === 0,
      `attempts=${after2.payment_reminder_12h_attempts}`,
    );

    // Forced permanent failure: shop with WA, but empty checkout + mock send that we
    // simulate by bumping attempts via three failing sends. Use a shop whose
    // Twilio path throws WhatsAppSendError by pointing to invalid config while WA set.
    // Simpler unit-style: set attempts to 2, clear sent_at/outcome, force a send that
    // fails via TWILIO_DRY_RUN still succeeding — so instead call finalize path by
    // invoking cron after manually setting a poison customer phone is hard.
    // Accept: skip permanent-fail live Twilio; assert API contract via DB update path
    // exercised by a direct library call when available. Here we verify job stays ok
    // even when cancel errors exist (counts present).
    record(
      "job succeeds with counts on no_channel skip",
      cron1.status === 200 &&
        cron1.json.ok === true &&
        typeof cron1.json.counts?.skipped === "number" &&
        cron1.json.counts.skipped >= 1,
      JSON.stringify(cron1.json.counts),
    );

    // Forced send failures via in-process runner (env must reach the library).
    const withWa = await provisionShop({ withWhatsApp: true });
    shops.push(withWa);

    function runChaseForced() {
      const tmp = resolve(root, `scripts/_tmp_pch_${randomUUID().slice(0, 6)}.mts`);
      writeFileSync(
        tmp,
        `
        import { createClient } from '@supabase/supabase-js';
        import { runPaymentChase } from '../src/lib/cron/payment-chase.ts';
        const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
        const result = await runPaymentChase(admin);
        console.log(JSON.stringify({ ok: true, counts: result.counts }));
        `,
      );
      const out = spawnSync(`npx --yes tsx "${tmp}"`, {
        cwd: root,
        env: {
          ...process.env,
          PAYMENT_CHASE_FORCE_SEND_ERROR: "1",
          TWILIO_DRY_RUN: "true",
          VERCEL_ENV: "",
        },
        encoding: "utf8",
        timeout: 120_000,
        shell: true,
      });
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop();
      let json = {};
      try {
        json = JSON.parse(line || "{}");
      } catch {
        json = { ok: false, raw: line, err: out.stderr?.slice(0, 200) };
      }
      return { status: out.status === 0 ? 200 : 500, json };
    }

    let permanent = null;
    let lastForced = null;
    for (let i = 0; i < 4; i++) {
      lastForced = runChaseForced();
      const { data } = await admin
        .from("orders")
        .select(
          "payment_reminder_12h_outcome, payment_reminder_12h_attempts, payment_reminder_12h_sent_at, payment_reminder_seller_alerted_at",
        )
        .eq("id", withWa.orderId)
        .single();
      permanent = data;
      if (data?.payment_reminder_12h_outcome === "failed") break;
    }

    record(
      "forced send failures: permanent failed after ≤3 attempts; job ok",
      lastForced?.status === 200 &&
        lastForced?.json?.ok === true &&
        permanent?.payment_reminder_12h_outcome === "failed" &&
        (permanent?.payment_reminder_12h_attempts ?? 0) >= 3 &&
        Boolean(permanent?.payment_reminder_12h_sent_at),
      `outcome=${permanent?.payment_reminder_12h_outcome} attempts=${permanent?.payment_reminder_12h_attempts} alerted=${Boolean(permanent?.payment_reminder_seller_alerted_at)} forced=${JSON.stringify(lastForced?.json)}`,
    );

    const cronAgain = await postCron();
    const { data: afterFail } = await admin
      .from("orders")
      .select("payment_reminder_12h_attempts, payment_reminder_12h_outcome")
      .eq("id", withWa.orderId)
      .single();
    record(
      "no further retries after permanent failure",
      cronAgain.status === 200 &&
        afterFail.payment_reminder_12h_outcome === "failed" &&
        afterFail.payment_reminder_12h_attempts ===
          permanent.payment_reminder_12h_attempts,
      `attempts=${afterFail.payment_reminder_12h_attempts}`,
    );
  } finally {
    for (const s of shops) {
      await deleteTestBusiness(admin, s.businessId, { ownerUserId: s.userId });
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n=== Summary: ${results.length - failed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
