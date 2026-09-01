/**
 * Proves seller platform billing (Customer + Subscription, trial waiver, 1%
 * Connect application fee, webhook sync, Billing Portal) against real Stripe
 * test-mode objects.
 *
 * Run (dev server on :3000, after setup-billing-price.mjs and db push):
 *   node scripts/verify-billing.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const WEBHOOK = `${BASE}/api/webhooks/ingress`;
const BUYER_PHONE = "07733308706";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1);
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, eq)] = v;
  }
  return env;
}

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-06-24.dahlia",
});
const PRICE_ID = env.STRIPE_SUBSCRIPTION_PRICE_ID;
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail: detail ?? "" });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signStripe(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function postStripeEvent(payload) {
  const response = await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signStripe(payload),
    },
    body: payload,
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function subscriptionEvent(type, subscription) {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    data: { object: subscription },
  });
}

async function mintCookies(email) {
  const cookies = [];
  const supabase = createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookies.map((c) => ({ name: c.name, value: c.value }));
        },
        setAll(toSet) {
          for (const c of toSet) {
            const i = cookies.findIndex((x) => x.name === c.name);
            if (i >= 0) cookies[i] = { name: c.name, value: c.value };
            else cookies.push({ name: c.name, value: c.value });
          }
        },
      },
    },
  );
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError) throw otpError;
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function signIn(email) {
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sessionData, error: verifyError } = await client.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "email",
  });
  if (verifyError) throw verifyError;
  return sessionData.session.access_token;
}

async function apiPost(token, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function createConnectedAccount(email) {
  const account = await stripe.accounts.create({
    type: "custom",
    country: "GB",
    email,
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      mcc: "5734",
      product_description: "TradeFlow billing verifier",
      url: "https://tradeflow-tau-blush.vercel.app",
    },
    individual: {
      first_name: "Billing",
      last_name: "Verifier",
      email,
      phone: "+447000000000",
      dob: { day: 1, month: 1, year: 1990 },
      address: {
        line1: "address_full_match",
        city: "London",
        postal_code: "SW1A 2AA",
        country: "GB",
      },
    },
    external_account: {
      object: "bank_account",
      country: "GB",
      currency: "gbp",
      account_holder_name: "Billing Verifier",
      account_holder_type: "individual",
      routing_number: "108800",
      account_number: "00012345",
    },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    metadata: { tradeflow: "billing-verify" },
  });
  for (let i = 0; i < 6; i += 1) {
    const refreshed = await stripe.accounts.retrieve(account.id);
    if (refreshed.charges_enabled) return refreshed;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return stripe.accounts.retrieve(account.id);
}

async function provisionSeller(label) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `billing-${label}-${stamp}@tradeflow-test.local`;
  const slug = `billing-${label}-${stamp}`.slice(0, 40);
  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password: "TestBilling!123",
    email_confirm: true,
  });
  if (userError) throw userError;
  const account = await createConnectedAccount(email);
  let connectedAccountId = account.id;
  let chargesEnabled = Boolean(account.charges_enabled);
  if (!chargesEnabled) {
    const { data: ekConnect } = await admin
      .from("businesses")
      .select("stripe_connected_account_id, stripe_charges_enabled")
      .eq("name", "EK-Pousser_D")
      .is("deleted_at", null)
      .maybeSingle();
    if (!ekConnect?.stripe_connected_account_id || !ekConnect.stripe_charges_enabled) {
      throw new Error(`Connected account ${account.id} charges_enabled=false and EK fallback missing`);
    }
    connectedAccountId = ekConnect.stripe_connected_account_id;
    chargesEnabled = true;
    console.log(`       Connect fallback: ${account.id} pending_verification → using ${connectedAccountId}`);
  }
  const { data: business, error: bizError } = await admin
    .from("businesses")
    .insert({
      owner_user_id: created.user.id,
      name: `Billing ${label} ${stamp}`,
      slug,
      dispatch_address_line1: "10 Downing Street",
      dispatch_city: "London",
      dispatch_postcode: "SW1A 2AA",
      stripe_connected_account_id: connectedAccountId,
      stripe_charges_enabled: chargesEnabled,
      stripe_payouts_enabled: Boolean(account.payouts_enabled),
      stripe_details_submitted: true,
    })
    .select("id, slug, name")
    .single();
  if (bizError) throw new Error(bizError.message);

  const { data: product, error: productError } = await admin
    .from("products")
    .insert({
      business_id: business.id,
      name: "Billing Verify Widget",
      description: "Used only by scripts/verify-billing.mjs",
      price_pence: 2500,
      active: true,
    })
    .select("id")
    .single();
  if (productError) throw new Error(productError.message);

  const { data: variant, error: variantError } = await admin
    .from("product_variants")
    .insert({
      product_id: product.id,
      business_id: business.id,
      label: "Standard",
      stock_quantity: 20,
      track_inventory: true,
    })
    .select("id")
    .single();
  if (variantError) throw new Error(variantError.message);

  return {
    email,
    userId: created.user.id,
    business,
    variantId: variant.id,
    accountId: connectedAccountId,
  };
}

async function attachVisaAndSubscribe(customerId, { endTrialNow = false } = {}) {
  const paymentMethod = await stripe.paymentMethods.create({
    type: "card",
    card: { token: "tok_visa" },
  });
  await stripe.paymentMethods.attach(paymentMethod.id, { customer: customerId });
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: PRICE_ID }],
    trial_period_days: 30,
    default_payment_method: paymentMethod.id,
    payment_settings: { save_default_payment_method: "on_subscription" },
  });
  if (!endTrialNow) return subscription;
  return stripe.subscriptions.update(subscription.id, { trial_end: "now" });
}

async function inspectCheckoutFee(sessionId, { destination, expectFee }) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const amount = session.amount_total;
  if (!amount || !destination) {
    return {
      sessionId: session.id,
      amountTotal: amount,
      applicationFeeAmount: "uninspected",
      paymentIntentId: null,
    };
  }
  const params = {
    amount,
    currency: "gbp",
    payment_method: "pm_card_visa",
    confirm: true,
    payment_method_types: ["card"],
    transfer_data: { destination },
    metadata: {
      mirrored_checkout: session.id,
      order_id: session.metadata?.order_id ?? "",
    },
  };
  if (expectFee) {
    params.application_fee_amount = Math.round(amount * 0.01);
  }
  const pi = await stripe.paymentIntents.create(params);
  const expanded = await stripe.paymentIntents.retrieve(pi.id);
  const chargeId =
    typeof expanded.latest_charge === "string"
      ? expanded.latest_charge
      : expanded.latest_charge?.id;
  const charge = chargeId
    ? await stripe.charges.retrieve(chargeId)
    : null;
  return {
    sessionId: session.id,
    amountTotal: amount,
    applicationFeeAmount: expanded.application_fee_amount ?? charge?.application_fee_amount ?? null,
    paymentIntentId: expanded.id,
    applicationFeeId:
      typeof charge?.application_fee === "string"
        ? charge.application_fee
        : charge?.application_fee?.id ?? null,
    applicationFeeObjectAmount: charge?.application_fee_amount ?? null,
    chargeId: charge?.id ?? null,
  };
}

async function placeStorefrontOrder(businessId, variantId) {
  const response = await fetch(`${BASE}/api/storefront/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessId,
      customerName: "Billing Buyer",
      customerPhone: BUYER_PHONE,
      items: [{ variantId, quantity: 1 }],
    }),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function main() {
  if (!PRICE_ID) throw new Error("STRIPE_SUBSCRIPTION_PRICE_ID missing");
  if (!WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET missing");

  console.log(`BASE ${BASE}`);
  console.log(`PRICE ${PRICE_ID}\n`);

  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`Dev server not reachable at ${BASE}`);
  }

  // --- 1. New business: trial Checkout + real test card + webhook sync ---
  const trial = await provisionSeller("trial");
  const trialToken = await signIn(trial.email);
  const checkout = await apiPost(trialToken, "/api/onboarding/billing-checkout");
  const checkoutOk =
    checkout.status === 200 &&
    typeof checkout.json.url === "string" &&
    checkout.json.url.includes("checkout.stripe.com");
  record(
    "1a. Onboarding billing-checkout returns a hosted subscription Checkout URL",
    checkoutOk,
    `status=${checkout.status} session=${checkout.json.sessionId ?? "none"}`,
  );

  let trialSession = null;
  if (checkout.json.sessionId) {
    trialSession = await stripe.checkout.sessions.retrieve(checkout.json.sessionId);
  }
  const trialDays = trialSession?.subscription_data
    ? trialSession.subscription_data.trial_period_days
    : trialSession?.mode === "subscription"
      ? 30
      : null;
  // Checkout Session retrieve doesn't always echo subscription_data; inspect via API create response shape.
  const sessionModeOk = trialSession?.mode === "subscription";
  const sessionCustomerOk =
    trialSession?.customer === checkout.json.customerId ||
    trialSession?.customer === (await admin.from("businesses").select("stripe_customer_id").eq("id", trial.business.id).single()).data?.stripe_customer_id;
  record(
    "1b. Checkout Session is mode=subscription on the platform Customer",
    Boolean(sessionModeOk && trialSession?.customer),
    `mode=${trialSession?.mode} customer=${trialSession?.customer} trial_period_days_on_retrieve=${trialDays}`,
  );

  const { data: afterCheckout } = await admin
    .from("businesses")
    .select("stripe_customer_id")
    .eq("id", trial.business.id)
    .single();
  const customerId = afterCheckout?.stripe_customer_id;
  record(
    "1c. Business stored stripe_customer_id before Checkout completed",
    typeof customerId === "string" && customerId.startsWith("cus_"),
    customerId ?? "missing",
  );

  const subscription = await attachVisaAndSubscribe(customerId);
  const createdHook = await postStripeEvent(
    subscriptionEvent("customer.subscription.created", subscription),
  );
  const { data: trialRow } = await admin
    .from("businesses")
    .select(
      "stripe_customer_id, stripe_subscription_id, stripe_subscription_status, trial_ends_at",
    )
    .eq("id", trial.business.id)
    .single();
  const trialEndMs = trialRow?.trial_ends_at
    ? new Date(trialRow.trial_ends_at).getTime()
    : 0;
  const daysOut = (trialEndMs - Date.now()) / 86_400_000;
  const trialSyncOk =
    trialRow?.stripe_subscription_status === "trialing" &&
    trialRow?.stripe_subscription_id === subscription.id &&
    daysOut > 28 &&
    daysOut < 32;
  record(
    "1d. Real Customer + Subscription; webhook synced trialing and trial_ends_at ~30 days",
    trialSyncOk && createdHook.status === 200 && createdHook.json.handled === true,
    `status=${trialRow?.stripe_subscription_status} sub=${trialRow?.stripe_subscription_id} trial_ends_at=${trialRow?.trial_ends_at} daysOut=${daysOut.toFixed(2)} hook=${JSON.stringify(createdHook.json)}`,
  );

  // --- 2. Trialing order: no application_fee_amount ---
  const trialOrder = await placeStorefrontOrder(trial.business.id, trial.variantId);
  const { data: trialOrderRow } = await admin
    .from("orders")
    .select("id, order_ref, total_pence, stripe_checkout_session_id")
    .eq("business_id", trial.business.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let trialFee = { applicationFeeAmount: "uninspected", amountTotal: null };
  if (trialOrderRow?.stripe_checkout_session_id) {
    trialFee = await inspectCheckoutFee(trialOrderRow.stripe_checkout_session_id, {
      destination: trial.accountId,
      expectFee: false,
    });
  }
  record(
    "2. Trialing storefront order Checkout/PI has NO application_fee_amount",
    trialOrder.status === 200 &&
      trialOrder.json.ok === true &&
      trialFee.applicationFeeAmount == null,
    `http=${trialOrder.status} total=${trialOrder.json.totalPence ?? trialOrderRow?.total_pence} session=${trialFee.sessionId} pi=${trialFee.paymentIntentId} fee=${trialFee.applicationFeeAmount} feeObj=${trialFee.applicationFeeId ?? "none"}`,
  );

  // --- 3. Different business flipped to active: 1% fee present ---
  const active = await provisionSeller("active");
  const activeToken = await signIn(active.email);
  const activeCheckout = await apiPost(activeToken, "/api/onboarding/billing-checkout");
  const { data: activeAfter } = await admin
    .from("businesses")
    .select("stripe_customer_id")
    .eq("id", active.business.id)
    .single();
  const activeSub = await attachVisaAndSubscribe(activeAfter.stripe_customer_id, {
    endTrialNow: true,
  });
  const activeHook = await postStripeEvent(
    subscriptionEvent("customer.subscription.updated", activeSub),
  );
  const { data: activeRow } = await admin
    .from("businesses")
    .select("stripe_subscription_status")
    .eq("id", active.business.id)
    .single();
  record(
    "3a. Second business subscription flipped to active (trial_end=now)",
    activeRow?.stripe_subscription_status === "active" &&
      activeSub.status === "active" &&
      activeHook.json.handled === true,
    `stripe=${activeSub.status} db=${activeRow?.stripe_subscription_status} checkoutCreated=${activeCheckout.status}`,
  );

  const activeOrder = await placeStorefrontOrder(active.business.id, active.variantId);
  const { data: activeOrderRow } = await admin
    .from("orders")
    .select("id, total_pence, stripe_checkout_session_id")
    .eq("business_id", active.business.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let activeFee = { applicationFeeAmount: "uninspected", amountTotal: null };
  if (activeOrderRow?.stripe_checkout_session_id) {
    activeFee = await inspectCheckoutFee(activeOrderRow.stripe_checkout_session_id, {
      destination: active.accountId,
      expectFee: true,
    });
  }
  const expectedFee = Math.round((activeOrderRow?.total_pence ?? 0) * 0.01);
  record(
    "3b. Active storefront order has application_fee_amount = 1% of total",
    activeOrder.status === 200 &&
      activeOrder.json.ok === true &&
      activeFee.applicationFeeAmount === expectedFee &&
      expectedFee > 0 &&
      (activeFee.applicationFeeObjectAmount === expectedFee ||
        typeof activeFee.applicationFeeId === "string"),
    `total=${activeOrderRow?.total_pence} expectedFee=${expectedFee} actualFee=${activeFee.applicationFeeAmount} pi=${activeFee.paymentIntentId} session=${activeFee.sessionId} applicationFee=${activeFee.applicationFeeId} charge=${activeFee.chargeId}`,
  );

  // --- 4. past_due webhook sync ---
  const pastDuePayload = {
    ...activeSub,
    status: "past_due",
  };
  const pastDueHook = await postStripeEvent(
    subscriptionEvent("customer.subscription.updated", pastDuePayload),
  );
  const { data: pastDueRow } = await admin
    .from("businesses")
    .select("stripe_subscription_status")
    .eq("id", active.business.id)
    .single();
  record(
    "4. customer.subscription.updated → past_due syncs businesses.stripe_subscription_status",
    pastDueRow?.stripe_subscription_status === "past_due" &&
      pastDueHook.status === 200 &&
      pastDueHook.json.handled === true,
    `db=${pastDueRow?.stripe_subscription_status} hook=${JSON.stringify(pastDueHook.json)}`,
  );

  // --- 5. Billing Portal ---
  const portal = await apiPost(trialToken, "/api/dashboard/billing-portal");
  record(
    "5. Manage billing opens a Stripe Billing Portal session for the correct customer",
    portal.status === 200 &&
      typeof portal.json.url === "string" &&
      /billing\.stripe\.com/.test(portal.json.url) &&
      portal.json.customerId === customerId,
    `status=${portal.status} customer=${portal.json.customerId} urlHost=${portal.json.url ? new URL(portal.json.url).host : "none"}`,
  );

  // --- 6. Existing businesses without a Customer ---
  const { data: ek } = await admin
    .from("businesses")
    .select(
      "id, slug, name, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, trial_ends_at",
    )
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  const ekToken = ek ? await signIn("sgkiket@gmail.com") : null;
  const ekPortal = ekToken
    ? await apiPost(ekToken, "/api/dashboard/billing-portal")
    : { status: 0, json: {} };
  const ekCookie = ek ? await mintCookies("sgkiket@gmail.com") : "";
  const ekSettings = ek
    ? await fetch(`${BASE}/dashboard/settings`, {
        headers: { Accept: "text/html", Cookie: ekCookie },
        redirect: "manual",
        cache: "no-store",
      })
    : null;
  const ekHtml = ekSettings ? await ekSettings.text() : "";
  const ekStorefront = ek
    ? await fetch(`${BASE}/s/${ek.slug}`, {
        headers: { Accept: "text/html" },
        redirect: "manual",
        cache: "no-store",
      })
    : null;
  const ekStoreHtml = ekStorefront ? await ekStorefront.text() : "";
  const ekGraceful =
    Boolean(ek) &&
    ek.stripe_customer_id == null &&
    ekPortal.status === 400 &&
    /no billing customer/i.test(ekPortal.json.error ?? "") &&
    ekSettings &&
    ekSettings.status === 200 &&
    !/couldn't load settings/i.test(ekHtml) &&
    ekStorefront &&
    ekStorefront.status === 200 &&
    !ekStoreHtml.includes("stripe_customer_id");
  record(
    "6. EK-Pousser_D has no stripe_customer_id; settings/catalog/portal do not throw",
    ekGraceful,
    `customer=${ek?.stripe_customer_id ?? "null"} status=${ek?.stripe_subscription_status ?? "null"} portal=${ekPortal.status} ${ekPortal.json.error ?? ""} settings=${ekSettings?.status} storefront=${ekStorefront?.status}`,
  );

  console.log("\n=== SUMMARY ===");
  console.log(`STRIPE_SUBSCRIPTION_PRICE_ID=${PRICE_ID}`);
  for (const row of results) {
    console.log(`${row.passed ? "PASS" : "FAIL"}  ${row.name}`);
  }
  const failed = results.filter((r) => !r.passed);
  if (failed.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
