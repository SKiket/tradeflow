/**
 * Verifies payment-chase cron (spec Section 12):
 *  1. 12h reminder sends + payment_reminder_12h_sent_at is set
 *  2. Immediate re-run does not double-send
 *  3. 24h+ auto-cancel reuses cancelAwaitingPaymentOrder (reservation
 *     released, Checkout expired, status CANCELLED)
 *  4. Requests without the shared secret are rejected
 *
 * Requires Next.js with CRON_SHARED_SECRET. Run:
 *   node scripts/verify-payment-chase.mjs
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447733308706";
const CRON_PATH = "/api/cron/payment-chase";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return env;
}

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY);
const CRON_SECRET = env.CRON_SHARED_SECRET;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function orderRef() {
  return `TF-CHASE-${randomBytes(3).toString("hex").toUpperCase()}`;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function postCron({ secret, header } = {}) {
  const url = new URL(CRON_PATH, BASE);
  const headers = { "Content-Type": "application/json" };
  if (header === "query") {
    url.searchParams.set("secret", secret);
  } else if (header === "none") {
    // omit
  } else if (secret) {
    headers["x-cron-secret"] = secret;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: "{}",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function countOutbound(threadId, needle) {
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text")
    .eq("thread_id", threadId)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${needle}%`);
  return (data ?? []).length;
}

async function loadSandboxContext() {
  const { data: business, error: bizError } = await admin
    .from("businesses")
    .select("id, stripe_connected_account_id")
    .eq("whatsapp_phone_e164", SANDBOX_NUMBER)
    .is("deleted_at", null)
    .maybeSingle();
  if (bizError || !business) {
    throw new Error(`Sandbox business not found: ${bizError?.message ?? "none"}`);
  }

  const { data: customer, error: custError } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", BUYER)
    .is("deleted_at", null)
    .maybeSingle();
  if (custError || !customer) {
    throw new Error(`Buyer customer not found: ${custError?.message ?? "none"}`);
  }

  const { data: variant, error: varError } = await admin
    .from("product_variants")
    .select("id, stock_quantity, reserved_quantity, track_inventory, products(price_pence, name)")
    .eq("business_id", business.id)
    .eq("track_inventory", true)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (varError || !variant) {
    throw new Error(`No tracked variant: ${varError?.message ?? "none"}`);
  }

  const { data: latestMsg } = await admin
    .from("messages")
    .select("thread_id")
    .eq("business_id", business.id)
    .eq("customer_id", customer.id)
    .not("thread_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    business,
    customer,
    variant,
    threadId: latestMsg?.thread_id ?? crypto.randomUUID(),
  };
}

async function createAwaitingOrder(ctx, { hoursAgo, withCheckout }) {
  const product = Array.isArray(ctx.variant.products)
    ? ctx.variant.products[0]
    : ctx.variant.products;
  const unitPrice = product?.price_pence ?? 100;
  const ref = orderRef();
  const reservedUntil = new Date(Date.now() + (24 * 60 * 60 - 60) * 1000).toISOString();

  const { data: order, error: orderError } = await admin
    .from("orders")
    .insert({
      business_id: ctx.business.id,
      customer_id: ctx.customer.id,
      thread_id: ctx.threadId,
      channel: "whatsapp",
      status: "AWAITING_PAYMENT",
      total_pence: unitPrice,
      order_ref: ref,
      reserved_until: reservedUntil,
    })
    .select("id, order_ref")
    .single();
  if (orderError || !order) {
    throw new Error(`Order insert failed: ${orderError?.message ?? "none"}`);
  }

  const { error: itemError } = await admin.from("order_items").insert({
    order_id: order.id,
    business_id: ctx.business.id,
    product_variant_id: ctx.variant.id,
    quantity: 1,
    unit_price_pence: unitPrice,
  });
  if (itemError) throw new Error(`Order item insert failed: ${itemError.message}`);

  if (ctx.variant.track_inventory) {
    await admin
      .from("product_variants")
      .update({ reserved_quantity: (ctx.variant.reserved_quantity ?? 0) + 1 })
      .eq("id", ctx.variant.id);
    ctx.variant.reserved_quantity = (ctx.variant.reserved_quantity ?? 0) + 1;
  }

  let checkoutSessionId = null;
  if (withCheckout) {
    const expiresAtUnix = Math.floor(Date.now() / 1000) + 24 * 60 * 60 - 60;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: unitPrice,
            product_data: { name: product?.name ?? "Chase test item" },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        transfer_data: { destination: ctx.business.stripe_connected_account_id },
        metadata: { order_id: order.id, order_ref: ref },
      },
      metadata: { order_id: order.id, order_ref: ref },
      success_url: `${BASE}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE}/pay/cancelled?order_ref=${encodeURIComponent(ref)}`,
      expires_at: expiresAtUnix,
    });
    checkoutSessionId = session.id;
    await admin
      .from("orders")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", order.id);
  }

  const changedAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  const { error: histError } = await admin.from("order_status_history").insert({
    order_id: order.id,
    business_id: ctx.business.id,
    from_status: "PENDING_CONFIRMATION",
    to_status: "AWAITING_PAYMENT",
    changed_at: changedAt,
  });
  if (histError) throw new Error(`Status history insert failed: ${histError.message}`);

  return { ...order, checkoutSessionId, changedAt };
}

async function main() {
  if (!CRON_SECRET) {
    throw new Error("CRON_SHARED_SECRET missing from .env.local");
  }

  const ctx = await loadSandboxContext();
  console.log("business", ctx.business.id);
  console.log("thread", ctx.threadId);

  const reservedBefore = ctx.variant.reserved_quantity ?? 0;

  const authNone = await postCron({ header: "none" });
  record(
    "5. rejects request without shared secret",
    authNone.status === 401,
    `status=${authNone.status} body=${JSON.stringify(authNone.json)}`,
  );

  const authWrong = await postCron({ secret: "definitely-not-the-secret" });
  record(
    "5b. rejects request with wrong shared secret",
    authWrong.status === 401,
    `status=${authWrong.status}`,
  );

  const twelveHour = await createAwaitingOrder(ctx, {
    hoursAgo: 12.25,
    withCheckout: true,
  });
  console.log("12h order", twelveHour.id, twelveHour.order_ref);

  const reminderNeedle = "Just a reminder";
  const beforeCount = await countOutbound(ctx.threadId, reminderNeedle);

  const firstRun = await postCron({ secret: CRON_SECRET });
  const firstHit = (firstRun.json.reminders12h ?? []).find(
    (row) => row.orderId === twelveHour.id,
  );
  const { data: afterFirst } = await admin
    .from("orders")
    .select("payment_reminder_12h_sent_at, status")
    .eq("id", twelveHour.id)
    .single();
  const afterCount = await countOutbound(ctx.threadId, reminderNeedle);

  record(
    "1. 12h reminder sends and payment_reminder_12h_sent_at is set",
    firstRun.status === 200 &&
      firstHit?.sent === true &&
      Boolean(afterFirst?.payment_reminder_12h_sent_at) &&
      afterCount === beforeCount + 1,
    `status=${firstRun.status} sent=${firstHit?.sent} sent_at=${afterFirst?.payment_reminder_12h_sent_at} msgs ${beforeCount}→${afterCount} checkoutUrlIncluded=${firstHit?.checkoutUrlIncluded}`,
  );

  await sleep(500);
  const secondRun = await postCron({ secret: CRON_SECRET });
  const secondHit = (secondRun.json.reminders12h ?? []).find(
    (row) => row.orderId === twelveHour.id,
  );
  const afterSecondCount = await countOutbound(ctx.threadId, reminderNeedle);
  const { data: afterSecond } = await admin
    .from("orders")
    .select("payment_reminder_12h_sent_at")
    .eq("id", twelveHour.id)
    .single();

  record(
    "2. immediate re-run does not duplicate the 12h reminder",
    secondRun.status === 200 &&
      !secondHit &&
      afterSecondCount === afterCount &&
      afterSecond?.payment_reminder_12h_sent_at === afterFirst?.payment_reminder_12h_sent_at,
    `secondHit=${JSON.stringify(secondHit ?? null)} msgs=${afterSecondCount} sent_at unchanged=${afterSecond?.payment_reminder_12h_sent_at === afterFirst?.payment_reminder_12h_sent_at}`,
  );

  const twentyFour = await createAwaitingOrder(ctx, {
    hoursAgo: 24.25,
    withCheckout: true,
  });
  console.log("24h order", twentyFour.id, twentyFour.order_ref, twentyFour.checkoutSessionId);

  const { data: variantBeforeCancel } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", ctx.variant.id)
    .single();

  const cancelRun = await postCron({ secret: CRON_SECRET });
  const cancelHit = (cancelRun.json.cancelled ?? []).find(
    (row) => row.orderId === twentyFour.id,
  );
  const { data: cancelledOrder } = await admin
    .from("orders")
    .select("status, reserved_until, stripe_checkout_session_id")
    .eq("id", twentyFour.id)
    .single();
  const { data: variantAfterCancel } = await admin
    .from("product_variants")
    .select("reserved_quantity")
    .eq("id", ctx.variant.id)
    .single();

  let checkoutStatus = null;
  if (twentyFour.checkoutSessionId) {
    const session = await stripe.checkout.sessions.retrieve(twentyFour.checkoutSessionId);
    checkoutStatus = session.status;
  }

  record(
    "3. 24h+ order cancelled via cancelAwaitingPaymentOrder (reservation + checkout + status)",
    cancelRun.status === 200 &&
      cancelHit?.via === "cancelAwaitingPaymentOrder" &&
      cancelHit?.action === "cancelled" &&
      cancelHit?.performed === true &&
      cancelledOrder?.status === "CANCELLED" &&
      cancelledOrder?.reserved_until === null &&
      (variantAfterCancel?.reserved_quantity ?? 0) ===
        (variantBeforeCancel?.reserved_quantity ?? 0) - 1 &&
      (checkoutStatus === "expired" ||
        cancelHit?.checkoutExpireOutcome === "expired" ||
        cancelHit?.checkoutExpireOutcome === "already_expired"),
    `via=${cancelHit?.via} performed=${cancelHit?.performed} expire=${cancelHit?.checkoutExpireOutcome} status=${cancelledOrder?.status} reserved ${variantBeforeCancel?.reserved_quantity}→${variantAfterCancel?.reserved_quantity} checkout=${checkoutStatus}`,
  );

  // Leave the 12h test order claimed so later real cron ticks do not re-send.
  // It is still AWAITING_PAYMENT; cancel it so it does not linger.
  if (afterFirst?.status === "AWAITING_PAYMENT") {
    await admin
      .from("orders")
      .update({
        payment_reminder_12h_sent_at: afterFirst.payment_reminder_12h_sent_at,
      })
      .eq("id", twelveHour.id);
    const cleanup = await admin
      .from("order_status_history")
      .update({
        changed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      })
      .eq("order_id", twelveHour.id)
      .eq("to_status", "AWAITING_PAYMENT");
    if (cleanup.error) {
      console.warn("could not backdate 12h order for cleanup", cleanup.error.message);
    } else {
      const mop = await postCron({ secret: CRON_SECRET });
      console.log("cleanup cancel of 12h test order", mop.json.cancelled ?? []);
    }
  }

  void reservedBefore;

  const failed = results.filter((r) => !r.passed);
  console.log("\n" + (failed.length ? `${failed.length} FAILED` : "ALL PASSED"));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
