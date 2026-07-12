/**
 * Verifies inbound WhatsApp normalisation end to end (Spec Section 6.4).
 *
 * Sends real Twilio-signed inbound webhook payloads to the running dev server
 * (same signature algorithm/format Twilio uses) and inspects the resulting
 * messages/customers rows, then checks RLS tenant isolation with real JWTs.
 *
 * Requires the dev server on localhost:3000. Run:
 *   node scripts/verify-whatsapp-normalisation.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886"; // Twilio WhatsApp sandbox
const SENDER_A = "+447700900001";
const SENDER_B = "+447700900002";

function loadEnv() {
  const env = {};
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

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(url, params) {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

let sidCounter = Date.now();
function nextSid() {
  sidCounter += 1;
  return `SM${sidCounter.toString(16)}${Math.random().toString(16).slice(2, 8)}`;
}

async function sendWhatsApp(params) {
  const full = { MessageSid: nextSid(), AccountSid: "ACtest", ...params };
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
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function jwtForEmail(email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const tokenHash = data.properties?.hashed_token;
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: session, error: otpError } = await anon.auth.verifyOtp({
    token_hash: tokenHash,
    type: "email",
  });
  if (otpError) throw new Error(`verifyOtp: ${otpError.message}`);
  return session.session.access_token;
}

function authedClient(accessToken) {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function main() {
  // --- Setup: target business + sandbox number ---
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, owner_user_id")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!business) throw new Error("No business found to test against.");

  await admin
    .from("businesses")
    .update({ whatsapp_phone_e164: SANDBOX_NUMBER })
    .eq("id", business.id);

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner.user?.email;
  console.log(`Target business: ${business.name} (${business.id})`);
  console.log(`Owner: ${ownerEmail}`);
  console.log(`WhatsApp number: ${SANDBOX_NUMBER}\n`);

  // --- Clean prior test data for a repeatable run ---
  const { data: oldCustomers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .in("phone_e164", [SENDER_A, SENDER_B]);
  const oldIds = (oldCustomers ?? []).map((c) => c.id);
  if (oldIds.length) {
    await admin.from("messages").delete().in("customer_id", oldIds);
    await admin.from("customers").delete().in("id", oldIds);
  }

  // --- Test 1: text from a new number ---
  const r1 = await sendWhatsApp({
    From: `whatsapp:${SENDER_A}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Alice Test",
    Body: "Hi, do you have size 10 in stock?",
    NumMedia: "0",
  });
  record(
    "Test 1: text lands verified + normalised",
    r1.status === 200 && r1.json.handled === true && r1.json.businessId === business.id,
    JSON.stringify(r1.json),
  );

  // --- Test 2: second message, same sender ---
  const r2 = await sendWhatsApp({
    From: `whatsapp:${SENDER_A}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Alice Test",
    Body: "Actually, make it size 11.",
    NumMedia: "0",
  });
  record(
    "Test 2: same sender resolves same customer + thread",
    r2.status === 200 &&
      r2.json.customerId === r1.json.customerId &&
      r2.json.threadId === r1.json.threadId &&
      r2.json.customerCreated === false,
    `customer ${r2.json.customerId} thread ${r2.json.threadId}`,
  );

  // --- Test 3: message from a different number ---
  const r3 = await sendWhatsApp({
    From: `whatsapp:${SENDER_B}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Bob Test",
    Body: "What's the price?",
    NumMedia: "0",
  });
  record(
    "Test 3: new sender creates a new customer",
    r3.status === 200 &&
      r3.json.customerId !== r1.json.customerId &&
      r3.json.customerCreated === true &&
      r3.json.businessId === business.id,
    `customer ${r3.json.customerId}`,
  );

  // --- Test 4: image with caption ---
  const mediaUrl = "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest";
  const r4 = await sendWhatsApp({
    From: `whatsapp:${SENDER_A}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Alice Test",
    Body: "Here's the photo",
    NumMedia: "1",
    MediaUrl0: mediaUrl,
    MediaContentType0: "image/jpeg",
  });
  record(
    "Test 4: media message captures mediaUrls",
    r4.status === 200 && r4.json.mediaCount === 1,
    `mediaCount ${r4.json.mediaCount}`,
  );

  // --- Inspect persisted rows (service role) ---
  const { data: rows } = await admin
    .from("messages")
    .select("id, business_id, customer_id, channel, direction, normalised_text, media_urls, thread_id, created_at, customers(phone_e164, name)")
    .eq("business_id", business.id)
    .order("created_at", { ascending: true });
  const testRows = (rows ?? []).filter((r) =>
    [SENDER_A, SENDER_B].includes(r.customers?.phone_e164),
  );
  console.log("\n=== messages rows created ===");
  for (const row of testRows) {
    console.log(
      `  ${row.customers?.phone_e164} | ${row.direction}/${row.channel} | ` +
        `text="${row.normalised_text}" | media=${JSON.stringify(row.media_urls)} | ` +
        `customer=${row.customer_id.slice(0, 8)} thread=${row.thread_id.slice(0, 8)}`,
    );
  }

  const mediaRow = testRows.find((r) => r.media_urls && r.media_urls.length > 0);
  record(
    "Test 4b: media_urls persisted in DB row",
    !!mediaRow && mediaRow.media_urls[0] === mediaUrl && mediaRow.normalised_text === "Here's the photo",
    mediaRow ? JSON.stringify(mediaRow.media_urls) : "no media row",
  );

  // --- Test 5: RLS isolation ---
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: anonRows } = await anon.from("messages").select("id").eq("business_id", business.id);
  record(
    "Test 5a: unauthenticated (anon) sees 0 messages",
    (anonRows ?? []).length === 0,
    `anon saw ${(anonRows ?? []).length} rows`,
  );

  let ownerToken;
  try {
    ownerToken = await jwtForEmail(ownerEmail);
    const ownerClient = authedClient(ownerToken);
    const { data: ownerRows } = await ownerClient
      .from("messages")
      .select("id")
      .eq("business_id", business.id);
    record(
      "Test 5b: owner sees their own messages",
      (ownerRows ?? []).length >= testRows.length && testRows.length > 0,
      `owner saw ${(ownerRows ?? []).length} rows`,
    );
  } catch (err) {
    record("Test 5b: owner sees their own messages", false, err.message);
  }

  // Throwaway second tenant
  const tenantBEmail = `rls-test-${Date.now()}@example.com`;
  let tenantBUserId;
  let tenantBBizId;
  try {
    const { data: created } = await admin.auth.admin.createUser({
      email: tenantBEmail,
      email_confirm: true,
    });
    tenantBUserId = created.user.id;
    const { data: bizB } = await admin
      .from("businesses")
      .insert({ owner_user_id: tenantBUserId, name: "RLS Test Tenant B", slug: `rls-test-${Date.now()}` })
      .select("id")
      .single();
    tenantBBizId = bizB.id;

    const tokenB = await jwtForEmail(tenantBEmail);
    const clientB = authedClient(tokenB);
    const { data: bView } = await clientB.from("messages").select("id").eq("business_id", business.id);
    const { data: bAll } = await clientB.from("messages").select("id");
    record(
      "Test 5c: other tenant sees 0 of business A's messages",
      (bView ?? []).length === 0 && (bAll ?? []).length === 0,
      `tenant B saw ${(bView ?? []).length} (filtered) / ${(bAll ?? []).length} (all)`,
    );
  } catch (err) {
    record("Test 5c: other tenant sees 0 of business A's messages", false, err.message);
  } finally {
    if (tenantBBizId) await admin.from("businesses").delete().eq("id", tenantBBizId);
    if (tenantBUserId) await admin.auth.admin.deleteUser(tenantBUserId);
  }

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
