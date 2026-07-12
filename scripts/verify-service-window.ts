/**
 * Verifies service-window tracking:
 *  1. last_customer_message_at column exists.
 *  2. An inbound message updates it to ~now.
 *  3. isInServiceWindow() → true immediately after.
 *  4. Backdated (>24h) → false.
 *  5. Never messaged (null) → false, no error.
 *
 * Imports the real helper. Requires the dev server on localhost:3000.
 * Run: node scripts/verify-service-window.ts
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { isInServiceWindow } from "../src/lib/channels/service-window.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const SENDER = "+447700900050";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results: { name: string; passed: boolean }[] = [];
function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(url: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

async function sendWhatsApp(params: Record<string, string>) {
  const full = { MessageSid: `SM${Date.now()}${Math.random().toString(16).slice(2, 8)}`, AccountSid: "ACtest", ...params };
  const body = new URLSearchParams(full).toString();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-Twilio-Signature": signTwilio(ENDPOINT, full),
    },
    body,
    redirect: "manual",
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name")
    .eq("whatsapp_phone_e164", SANDBOX_NUMBER)
    .maybeSingle();
  if (!business) throw new Error("No business mapped to the sandbox number.");
  console.log(`Target business: ${business.name} (${business.id})\n`);

  // Clean prior test data for a repeatable run.
  const { data: prior } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .in("phone_e164", [SENDER, "+447700900051"]);
  const priorIds = (prior ?? []).map((c) => c.id);
  if (priorIds.length) {
    await admin.from("messages").delete().in("customer_id", priorIds);
    await admin.from("customers").delete().in("id", priorIds);
  }

  // --- Test 1: column exists (selecting it succeeds) ---
  const { error: colError } = await admin
    .from("customers")
    .select("id, last_customer_message_at")
    .limit(1);
  record("Test 1: last_customer_message_at column exists", !colError, colError?.message);

  // --- Test 2: inbound message updates the timestamp ---
  const before = Date.now();
  const send = await sendWhatsApp({
    From: `whatsapp:${SENDER}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Window Test",
    Body: "Testing service window",
    NumMedia: "0",
  });
  const { data: customer } = await admin
    .from("customers")
    .select("id, last_customer_message_at")
    .eq("business_id", business.id)
    .eq("phone_e164", SENDER)
    .single();
  const ts = customer?.last_customer_message_at ? Date.parse(customer.last_customer_message_at) : NaN;
  const fresh = !Number.isNaN(ts) && ts >= before - 2000 && ts <= Date.now() + 2000;
  record(
    "Test 2: inbound message sets last_customer_message_at to ~now",
    send.status === 200 && fresh,
    `last_customer_message_at=${customer?.last_customer_message_at}`,
  );

  // --- Test 3: isInServiceWindow true immediately after ---
  record(
    "Test 3: isInServiceWindow() true just after inbound",
    isInServiceWindow(customer!) === true,
    `now=${new Date().toISOString()}`,
  );

  // --- Test 4: backdate > 24h → false ---
  const backdated = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await admin.from("customers").update({ last_customer_message_at: backdated }).eq("id", customer!.id);
  const { data: backdatedCustomer } = await admin
    .from("customers")
    .select("id, last_customer_message_at")
    .eq("id", customer!.id)
    .single();
  record(
    "Test 4: isInServiceWindow() false when backdated >24h",
    isInServiceWindow(backdatedCustomer!) === false,
    `last_customer_message_at=${backdatedCustomer?.last_customer_message_at}`,
  );

  // --- Test 5: never messaged (null) → false ---
  const { data: neverMessaged } = await admin
    .from("customers")
    .insert({ business_id: business.id, phone_e164: "+447700900051", name: "Never Messaged" })
    .select("id, last_customer_message_at")
    .single();
  record(
    "Test 5: isInServiceWindow() false when last_customer_message_at null",
    neverMessaged!.last_customer_message_at === null && isInServiceWindow(neverMessaged!) === false,
    `value=${neverMessaged?.last_customer_message_at}`,
  );
  await admin.from("customers").delete().eq("id", neverMessaged!.id);

  console.log("\n========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
