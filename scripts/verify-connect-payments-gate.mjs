/**
 * Step 23 — Connect card/transfers payment gate.
 *   node scripts/verify-connect-payments-gate.mjs
 */
import { canTakeCardPayments } from "../src/lib/stripe/connect-capabilities.ts";
import {
  cleanBuyerOrders,
  createAdmin,
  ensureSeedCatalog,
  liveVariants,
  loadVerifyEnv,
  newRunId,
  phoneFromRunId,
} from "./lib/verify-harness.mjs";
import { createHmac } from "node:crypto";

loadVerifyEnv();
const admin = createAdmin();
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX = "+14155238886";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const runId = newRunId("paygate");
const BUYER = phoneFromRunId(runId, 0);
process.env.TWILIO_DRY_RUN = "true";

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(urlStr, params) {
  const sorted = Object.keys(params).sort();
  let data = urlStr;
  for (const k of sorted) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

let sid = Date.now();
async function sendWhatsApp(bodyText) {
  sid += 1;
  const full = {
    MessageSid: `SM${sid.toString(16)}`,
    AccountSid: "ACtest",
    From: `whatsapp:${BUYER}`,
    To: `whatsapp:${SANDBOX}`,
    ProfileName: "PayGate",
    Body: bodyText,
    NumMedia: "0",
  };
  const body = new URLSearchParams(full).toString();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-TradeFlow-Verify": "1",
      "X-Twilio-Signature": signTwilio(ENDPOINT, full),
    },
    body,
    redirect: "manual",
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

record(
  "pure: disabled account cannot take card payments",
  canTakeCardPayments({
    stripe_connected_account_id: "acct_x",
    stripe_charges_enabled: true,
    stripe_transfers_capability_active: false,
  }) === false,
);
record(
  "pure: enabled account can take card payments",
  canTakeCardPayments({
    stripe_connected_account_id: "acct_x",
    stripe_charges_enabled: true,
    stripe_transfers_capability_active: true,
  }) === true,
);

async function main() {
  console.log(`runId=${runId} buyer=${BUYER}`);
  const { data: business } = await admin
    .from("businesses")
    .select(
      "id, stripe_connected_account_id, stripe_charges_enabled, stripe_transfers_capability_active",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("pilot missing");

  record(
    "pilot synced: canTakeCardPayments true",
    canTakeCardPayments(business) === true,
    JSON.stringify({
      charges: business.stripe_charges_enabled,
      transfers: business.stripe_transfers_capability_active,
    }),
  );

  await cleanBuyerOrders(admin, business.id, BUYER);
  const products = await ensureSeedCatalog(admin, business.id);
  const mug = products.find((p) => /blue mug/i.test(p.name));
  const variant = liveVariants(mug)[0];
  if (!variant) throw new Error("no mug variant");

  // Snapshot + force disabled
  const snap = {
    stripe_charges_enabled: business.stripe_charges_enabled,
    stripe_transfers_capability_active: business.stripe_transfers_capability_active,
  };
  await admin
    .from("businesses")
    .update({ stripe_transfers_capability_active: false })
    .eq("id", business.id);

  try {
    await sendWhatsApp(`I'd like 1 of the ${mug.name}`);
    await sleep(3000);
    await sendWhatsApp("yes");
    await sleep(2500);

    const { data: customers } = await admin
      .from("customers")
      .select("id")
      .eq("business_id", business.id)
      .eq("phone_e164", BUYER);
    const cid = customers?.[0]?.id;
    const { data: order } = await admin
      .from("orders")
      .select("id, status, order_ref, stripe_checkout_session_id")
      .eq("business_id", business.id)
      .eq("customer_id", cid)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    record(
      "disabled: draft stays unpaid (PENDING_CONFIRMATION), no checkout session",
      order?.status === "PENDING_CONFIRMATION" && !order?.stripe_checkout_session_id,
      `status=${order?.status} session=${order?.stripe_checkout_session_id}`,
    );

    const { data: outbound } = await admin
      .from("messages")
      .select("normalised_text")
      .eq("customer_id", cid)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(5);
    const buyerTold = (outbound ?? []).some((m) =>
      /cannot take card payments|seller has been told|paiements par carte/i.test(
        m.normalised_text || "",
      ),
    );
    record("disabled: buyer gets fixed payments-unavailable reply", buyerTold);

    // Re-enable and confirm payment link works
    await admin
      .from("businesses")
      .update({
        stripe_charges_enabled: true,
        stripe_transfers_capability_active: true,
      })
      .eq("id", business.id);

    await sendWhatsApp("yes");
    await sleep(3000);
    const { data: after } = await admin
      .from("orders")
      .select("id, status, stripe_checkout_session_id")
      .eq("id", order.id)
      .maybeSingle();
    record(
      "enabled: confirm creates checkout / awaiting payment",
      after?.status === "AWAITING_PAYMENT" && Boolean(after?.stripe_checkout_session_id),
      `status=${after?.status} session=${Boolean(after?.stripe_checkout_session_id)}`,
    );
  } finally {
    await admin
      .from("businesses")
      .update({
        stripe_charges_enabled: snap.stripe_charges_enabled,
        stripe_transfers_capability_active: snap.stripe_transfers_capability_active,
      })
      .eq("id", business.id);
    await cleanBuyerOrders(admin, business.id, BUYER);
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n=== Summary: ${results.length - failed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
