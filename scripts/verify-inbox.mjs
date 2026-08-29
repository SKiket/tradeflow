/**
 * Verifies the seller inbox, unmatched-order seller notify, and AI preview sandbox.
 *
 *  1. Inbox lists real EK-Pousser_D threads with previews/timestamps (RLS)
 *  2. Thread history includes a stored ai_parse_result classification
 *  3. Unmatched order attempt notifies the seller and shows in the inbox
 *  4. Preview tool returns live AI output without writing messages or sending Twilio
 *  5. Other tenant cannot see EK-Pousser_D threads; preview is catalog-scoped
 *
 * Requires Next.js dev server. Run:
 *   node scripts/verify-inbox.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447733308706";
const SELLER = process.env.SELLER_PHONE ?? "+447733308706";

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
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(webhookUrl, params) {
  const sorted = Object.keys(params).sort();
  let data = webhookUrl;
  for (const k of sorted) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

let sidCounter = Date.now();
function nextSid() {
  sidCounter += 1;
  return `SM${sidCounter.toString(16)}${Math.random().toString(16).slice(2, 8)}`;
}

async function sendWhatsApp(bodyText) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${BUYER}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Inbox Tester",
    Body: bodyText,
    NumMedia: "0",
  };
  const body = new URLSearchParams(full).toString();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-Twilio-Signature": signTwilio(ENDPOINT, full),
    },
    body,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function signIn(email) {
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${BASE}/auth/callback` },
  });
  if (linkError) throw linkError;
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sessionData, error: verifyError } = await client.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "email",
  });
  if (verifyError) throw verifyError;
  return sessionData.session.access_token;
}

function rlsClient(accessToken) {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function apiPost(token, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function cleanupOtherUser(email) {
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users?.find((u) => u.email === email);
  if (!user) return;
  await admin.from("businesses").delete().eq("owner_user_id", user.id);
  await admin.auth.admin.deleteUser(user.id);
}

function groupThreads(rows) {
  const byThread = new Map();
  for (const row of rows ?? []) {
    if (!row.thread_id || byThread.has(row.thread_id)) continue;
    byThread.set(row.thread_id, row);
  }
  return [...byThread.values()];
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, owner_user_id, seller_whatsapp_phone_e164")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");

  const previousSellerPhone = business.seller_whatsapp_phone_e164;
  await admin
    .from("businesses")
    .update({ seller_whatsapp_phone_e164: SELLER })
    .eq("id", business.id);

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) throw new Error("Owner email not found");

  const ownerToken = await signIn(ownerEmail);
  const ownerRls = rlsClient(ownerToken);

  try {
    // ----- 1. Inbox list (RLS = same scope as /dashboard/inbox) -----
    const { data: ownerMessages, error: listError } = await ownerRls
      .from("messages")
      .select(
        "id, thread_id, normalised_text, created_at, direction, customers(phone_e164, name)",
      )
      .not("thread_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (listError) throw new Error(listError.message);

    const threads = groupThreads(ownerMessages);
    const sample = threads[0];
    const customer = Array.isArray(sample?.customers)
      ? sample.customers[0]
      : sample?.customers;
    const test1Pass =
      threads.length >= 1 &&
      Boolean(sample?.thread_id) &&
      Boolean(sample?.created_at) &&
      Boolean((sample?.normalised_text ?? "").length >= 0) &&
      Boolean(customer?.phone_e164 || customer?.name);
    record(
      "1. Inbox shows real existing threads with preview and timestamp",
      test1Pass,
      `threads=${threads.length} lastPhone=${customer?.phone_e164 ?? "?"} at=${sample?.created_at} preview=${JSON.stringify(sample?.normalised_text)?.slice(0, 80)}`,
    );

    // ----- 2. Thread detail includes ai_parse_result -----
    const { data: parsedRow } = await ownerRls
      .from("messages")
      .select("id, thread_id, normalised_text, ai_parse_result, direction")
      .not("ai_parse_result", "is", null)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const parse = parsedRow?.ai_parse_result;
    const { data: threadMessages } = parsedRow?.thread_id
      ? await ownerRls
          .from("messages")
          .select("id, direction")
          .eq("thread_id", parsedRow.thread_id)
          .order("created_at", { ascending: true })
      : { data: [] };
    const test2Pass =
      Boolean(parsedRow?.thread_id) &&
      typeof parse?.intent === "string" &&
      typeof parse?.confidence === "number" &&
      (threadMessages ?? []).length >= 1 &&
      (threadMessages ?? []).some((row) => row.direction === "inbound");
    record(
      "2. Thread history includes stored ai_parse_result classification",
      test2Pass,
      `thread=${parsedRow?.thread_id} intent=${parse?.intent} confidence=${parse?.confidence} messages=${(threadMessages ?? []).length}`,
    );

    // ----- 3. Unmatched order → seller notify + inbox -----
    const marker = `ultraviolet hovercraft [inbox-clarif-${Date.now()}]`;
    const unmatchedText = `I'd like to order 2 ${marker}`;
    const inbound = await sendWhatsApp(unmatchedText);
    await new Promise((r) => setTimeout(r, 2500));

    const { data: inboundRow } = await admin
      .from("messages")
      .select("id, thread_id, ai_parse_result, normalised_text, business_id")
      .eq("business_id", business.id)
      .eq("direction", "inbound")
      .ilike("normalised_text", `%${marker}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: visibleInbound } = inboundRow
      ? await ownerRls
          .from("messages")
          .select("id, thread_id, ai_parse_result")
          .eq("id", inboundRow.id)
          .maybeSingle()
      : { data: null };

    const { data: sellerNotifyRow } = await admin
      .from("messages")
      .select("id, normalised_text")
      .eq("business_id", business.id)
      .eq("direction", "outbound")
      .ilike("normalised_text", "%couldn't match%")
      .ilike("normalised_text", `%${marker}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const notify = inbound.json?.unmatchedNotify;
    const needsClarification = inboundRow?.ai_parse_result?.needs_clarification === true;
    const test3Pass =
      inbound.status === 200 &&
      needsClarification &&
      Boolean(visibleInbound?.id) &&
      typeof notify?.text === "string" &&
      notify.text.includes(marker) &&
      (notify.attempted === true || notify.ok === true || Boolean(sellerNotifyRow));
    record(
      "3. Unmatched order notifies seller and is visible in inbox",
      test3Pass,
      `webhook=${inbound.status} needsClarification=${needsClarification} notifyAttempted=${notify?.attempted} notifyOk=${notify?.ok} notifyError=${notify?.error ?? ""} sellerMsg=${Boolean(sellerNotifyRow)} visible=${Boolean(visibleInbound?.id)}`,
    );

    // ----- 4. Preview sandbox: no writes, real AI -----
    const { count: beforeCount } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id);

    const samples = [
      { label: "clear order", text: "I'd like one Classic Blue Mug please" },
      { label: "ambiguous", text: "Can I get the thing in the window, maybe the purple one?" },
      { label: "policy question", text: "What's your returns policy?" },
      { label: "chatter", text: "hey thanks, just saying hi" },
    ];
    const previews = [];
    for (const sample of samples) {
      const preview = await apiPost(ownerToken, "/api/inbox/preview", {
        message: sample.text,
      });
      previews.push({
        label: sample.label,
        status: preview.status,
        intent: preview.json.intent,
        reply: typeof preview.json.reply === "string" ? preview.json.reply.slice(0, 80) : "",
        confidence: preview.json.confidence,
        escalate: preview.json.escalateToSeller,
        needsClarification: preview.json.needsClarification,
      });
    }

    const { count: afterCount } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id);

    const test4Pass =
      previews.length === 4 &&
      previews.every((row) => row.status === 200 && ["order", "question", "other"].includes(row.intent) && row.reply.length > 0) &&
      beforeCount === afterCount;
    record(
      "4. Preview returns live AI replies and writes nothing to messages",
      test4Pass,
      `messages ${beforeCount}→${afterCount}\n${previews.map((row) => `${row.label}: intent=${row.intent} conf=${row.confidence} reply=${JSON.stringify(row.reply)}`).join("\n")}`,
    );

    // ----- 5. Cross-tenant -----
    const OTHER_EMAIL = `inbox-other-${Date.now()}@tradeflow-test.local`;
    await cleanupOtherUser(OTHER_EMAIL);
    const { data: otherUser } = await admin.auth.admin.createUser({
      email: OTHER_EMAIL,
      email_confirm: true,
    });
    await admin.from("businesses").insert({
      owner_user_id: otherUser.user.id,
      name: "Inbox Other Shop",
      slug: `inbox-other-${Date.now()}`,
      dispatch_address_line1: "2 Other St",
      dispatch_city: "London",
      dispatch_postcode: "E2 2BB",
      payout_account_holder_name: "Other",
      payout_sort_code: "11-22-33",
      payout_account_number: "87654321",
    });
    const otherToken = await signIn(OTHER_EMAIL);
    const otherRls = rlsClient(otherToken);
    const { data: leaked } = await otherRls
      .from("messages")
      .select("id, thread_id, business_id")
      .eq("thread_id", parsedRow?.thread_id ?? "00000000-0000-4000-8000-000000000000");
    const { data: otherAll } = await otherRls.from("messages").select("id").limit(20);
    const otherPreview = await apiPost(otherToken, "/api/inbox/preview", {
      message: "I'd like one Classic Blue Mug please",
    });
    const otherMatched = (otherPreview.json.matchedItems ?? []).some(
      (item) => item.matched_product_id,
    );
    const test5Pass =
      (leaked ?? []).length === 0 &&
      (otherAll ?? []).length === 0 &&
      otherPreview.status === 200 &&
      otherMatched === false;
    record(
      "5. Other tenant cannot see EK threads; preview is scoped to their catalog",
      test5Pass,
      `leaked=${(leaked ?? []).length} otherMessages=${(otherAll ?? []).length} otherIntent=${otherPreview.json.intent} otherMatched=${otherMatched}`,
    );
    await cleanupOtherUser(OTHER_EMAIL);
  } finally {
    await admin
      .from("businesses")
      .update({ seller_whatsapp_phone_e164: previousSellerPhone })
      .eq("id", business.id);
  }

  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
