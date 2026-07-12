/**
 * Verifies webhook ingress per Step 5 requirements.
 * Requires dev server: npm run dev
 * Run: node scripts/verify-webhook-ingress.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;

if (!TWILIO_TOKEN) {
  console.error("TWILIO_AUTH_TOKEN missing from .env.local");
  process.exit(1);
}

function signTwilio(url, params) {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const key of sorted) data += key + params[key];
  return createHmac("sha1", TWILIO_TOKEN)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
}

// Reproduces Stripe's Stripe-Signature header: t=<ts>,v1=HMAC-SHA256(secret, `${ts}.${payload}`)
function signStripe(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function postWebhook({
  source,
  body,
  contentType = "application/x-www-form-urlencoded",
  headers = {},
}) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Source": source,
      ...headers,
    },
    body,
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, location: response.headers.get("location") };
}

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function main() {
  console.log(`Endpoint: ${ENDPOINT}\n`);

  // Test 6: no auth middleware redirect
  const noAuth = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "X-Source": "twilio-sms" },
    body: "Body=hi",
    redirect: "manual",
  });
  record(
    "Test 6: no auth middleware redirect to /login",
    noAuth.status !== 307 &&
      noAuth.status !== 308 &&
      !noAuth.headers.get("location")?.includes("/login"),
    `status=${noAuth.status}, location=${noAuth.headers.get("location")}`,
  );

  // Test 5: unknown X-Source
  const unknown = await postWebhook({ source: "acme-unknown", body: "{}" });
  record(
    "Test 5: unrecognised X-Source → 400",
    unknown.status === 400,
    `status=${unknown.status}`,
  );

  // Test 2: tampered Twilio signature
  const twilioParams = {
    MessageSid: "SM_VERIFY_001",
    Body: "hello",
    From: "+441234567890",
    To: "+449876543210",
  };
  const twilioBody = new URLSearchParams(twilioParams).toString();
  const validSig = signTwilio(ENDPOINT, twilioParams);

  const badSig = await postWebhook({
    source: "twilio-sms",
    body: twilioBody,
    headers: { "X-Twilio-Signature": "tampered-signature" },
  });
  record(
    "Test 2: tampered Twilio signature → 401",
    badSig.status === 401 && badSig.json.error === "Unauthorized",
    `status=${badSig.status}`,
  );

  // Test 1: valid Twilio signature
  const valid = await postWebhook({
    source: "twilio-sms",
    body: twilioBody,
    headers: {
      "X-Twilio-Signature": validSig,
      "Idempotency-Key": "idem-verify-001",
    },
  });
  record(
    "Test 1: real Twilio signature → 200, verification=real",
    valid.status === 200 &&
      valid.json.ok === true &&
      valid.json.source === "twilio-sms" &&
      valid.json.verification === "real",
    JSON.stringify(valid.json),
  );

  // Test 4: duplicate idempotency key
  const duplicate = await postWebhook({
    source: "twilio-sms",
    body: twilioBody,
    headers: {
      "X-Twilio-Signature": validSig,
      "Idempotency-Key": "idem-verify-001",
    },
  });
  record(
    "Test 4: duplicate idempotency key flagged",
    duplicate.status === 200 && duplicate.json.duplicate === true,
    `duplicate=${duplicate.json.duplicate}`,
  );

  // Test 3: Stripe real verification (valid + tampered)
  if (STRIPE_WEBHOOK_SECRET) {
    const stripePayload = JSON.stringify({
      id: "evt_verify_001",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_verify_001" } },
    });

    const stripeValid = await postWebhook({
      source: "stripe",
      body: stripePayload,
      contentType: "application/json",
      headers: {
        "Stripe-Signature": signStripe(stripePayload, STRIPE_WEBHOOK_SECRET),
      },
    });
    record(
      "Test 3a: real Stripe signature → 200, verification=real",
      stripeValid.status === 200 &&
        stripeValid.json.ok === true &&
        stripeValid.json.source === "stripe" &&
        stripeValid.json.verification === "real",
      JSON.stringify(stripeValid.json),
    );

    const stripeBad = await postWebhook({
      source: "stripe",
      body: stripePayload,
      contentType: "application/json",
      headers: { "Stripe-Signature": "t=123,v1=deadbeef" },
    });
    record(
      "Test 3b: tampered Stripe signature → 401",
      stripeBad.status === 401 && stripeBad.json.error === "Unauthorized",
      `status=${stripeBad.status}`,
    );
  } else {
    console.log(
      "SKIP — Stripe tests (set STRIPE_WEBHOOK_SECRET in .env.local to run)",
    );
  }

  // Shippo stub path (no HMAC secret configured yet)
  const shippo = await postWebhook({
    source: "shippo",
    body: JSON.stringify({ event: "track_updated" }),
    contentType: "application/json",
  });
  record(
    "Test 3c: Shippo stub path → 200, verification=stub",
    shippo.status === 200 &&
      shippo.json.verification === "stub" &&
      shippo.json.stubReason?.includes("SHIPPO"),
    JSON.stringify(shippo.json),
  );

  console.log("\n========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  console.log("\nVerification status:");
  console.log("  REAL:  twilio-whatsapp, twilio-sms");
  console.log("  REAL:  stripe (STRIPE_WEBHOOK_SECRET)");
  console.log("  STUB:  shippo (no SHIPPO_WEBHOOK_SECRET)");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
