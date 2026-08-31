/**
 * Verifies inbox seller replies and AI human-takeover pause.
 *
 *  1. Seller reply sends via Twilio, sets ai_paused_until ~24h out
 *     (outside-window warning 409 first; send still allowed with ack)
 *  2. Signed inbound while paused is stored but skips order_parse/support_reply
 *  3. Resume AI clears the flag; a clear order inbound creates a normal draft
 *  4. A further manual reply extends the pause 24h from that send
 *  5. Inbox list data distinguishes paused vs AI-covered threads
 *  6. Other tenant cannot see or reply in EK-Pousser_D threads
 *
 * Uses the sandbox-joined buyer phone so the reply is a real WhatsApp send.
 * Always resumes AI in finally so we don't leave the live buyer paused.
 *
 * Requires Next.js dev server. Run:
 *   node scripts/verify-inbox-reply.mjs
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
const BUYER = process.env.TO_PHONE ?? "+447733308706";
const OUTSIDE_WINDOW_MESSAGE =
  "This may not deliver: the customer hasn't messaged in the last 24 hours and free-form replies can fail outside that window";

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
    ProfileName: "Inbox Reply Tester",
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

function hoursFromNow(iso) {
  if (!iso) return null;
  return (Date.parse(iso) - Date.now()) / 3600000;
}

function isPausedSkip(parse) {
  return parse?.skipped === true && parse?.reason === "ai_paused";
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, owner_user_id")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");

  const { data: owner } = await admin.auth.admin.getUserById(business.owner_user_id);
  const ownerEmail = owner?.user?.email;
  if (!ownerEmail) throw new Error("Owner email not found");
  const ownerToken = await signIn(ownerEmail);
  const ownerRls = rlsClient(ownerToken);

  const marker = `inbox-reply-${Date.now()}`;
  let customerId = null;
  let threadId = null;
  let createdDraftId = null;
  const priorDraftIds = new Set();

  try {
    // Open the 24h service window without placing an order.
    const openWindow = await sendWhatsApp(`hey thanks, just saying hi [${marker}]`);
    await new Promise((r) => setTimeout(r, 1500));
    customerId = openWindow.json.customerId;
    threadId = openWindow.json.threadId;
    if (!customerId || !threadId) {
      throw new Error(`Failed to open thread: ${JSON.stringify(openWindow)}`);
    }

    const { data: priorDrafts } = await admin
      .from("orders")
      .select("id")
      .eq("thread_id", threadId)
      .eq("status", "PENDING_CONFIRMATION")
      .is("deleted_at", null);
    for (const row of priorDrafts ?? []) priorDraftIds.add(row.id);

    const { data: customerBefore } = await admin
      .from("customers")
      .select("id, ai_paused_until, last_customer_message_at")
      .eq("id", customerId)
      .maybeSingle();
    if (!customerBefore) throw new Error("Customer row missing after inbound");

    // ----- 1. Warning + real send + pause -----
    const originalLast = customerBefore.last_customer_message_at;
    await admin
      .from("customers")
      .update({
        last_customer_message_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      })
      .eq("id", customerId);

    const blocked = await apiPost(ownerToken, `/api/inbox/${threadId}/reply`, {
      text: `TradeFlow inbox reply (should warn) ${marker}`,
    });
    const warningOk =
      blocked.status === 409 &&
      blocked.json.code === "OUTSIDE_SERVICE_WINDOW" &&
      blocked.json.error === OUTSIDE_WINDOW_MESSAGE;

    await admin
      .from("customers")
      .update({ last_customer_message_at: originalLast })
      .eq("id", customerId);

    const replyText = `TradeFlow inbox reply ${marker}`;
    const sent = await apiPost(ownerToken, `/api/inbox/${threadId}/reply`, {
      text: replyText,
    });
    const { data: customerAfterReply } = await admin
      .from("customers")
      .select("ai_paused_until")
      .eq("id", customerId)
      .maybeSingle();
    const pauseHours = hoursFromNow(customerAfterReply?.ai_paused_until);
    const { data: outboundRow } = sent.json.messageId
      ? await admin
          .from("messages")
          .select("id, direction, normalised_text, thread_id")
          .eq("id", sent.json.messageId)
          .maybeSingle()
      : { data: null };

    const test1Pass =
      warningOk &&
      sent.status === 200 &&
      sent.json.ok === true &&
      typeof sent.json.messageId === "string" &&
      outboundRow?.direction === "outbound" &&
      outboundRow?.normalised_text === replyText &&
      pauseHours != null &&
      pauseHours > 23 &&
      pauseHours < 25;
    record(
      "1. Seller reply sends, warns outside the window first, pauses AI ~24h",
      test1Pass,
      `warn=${blocked.status}/${blocked.json.code} send=${sent.status} messageId=${sent.json.messageId ?? ""} pauseHours=${pauseHours?.toFixed(2)} outbound=${Boolean(outboundRow)}`,
    );

    const pauseUntil1 = customerAfterReply?.ai_paused_until;

    // ----- 2. Inbound while paused -----
    const { count: outboundBefore } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", threadId)
      .eq("direction", "outbound")
      .is("deleted_at", null);

    const pausedInboundText = `I'd like one Classic Blue Mug please [${marker}-paused]`;
    const pausedInbound = await sendWhatsApp(pausedInboundText);
    await new Promise((r) => setTimeout(r, 1500));

    const { data: pausedRow } = await admin
      .from("messages")
      .select("id, ai_parse_result, normalised_text, thread_id")
      .eq("id", pausedInbound.json.messageId)
      .maybeSingle();
    const { data: visiblePaused } = pausedRow
      ? await ownerRls
          .from("messages")
          .select("id, ai_parse_result")
          .eq("id", pausedRow.id)
          .maybeSingle()
      : { data: null };
    const { count: outboundAfterPaused } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", threadId)
      .eq("direction", "outbound")
      .is("deleted_at", null);

    const test2Pass =
      pausedInbound.status === 200 &&
      pausedInbound.json.aiPaused === true &&
      pausedInbound.json.parseStored === false &&
      isPausedSkip(pausedRow?.ai_parse_result) &&
      Boolean(visiblePaused?.id) &&
      outboundAfterPaused === outboundBefore &&
      !pausedInbound.json.draft &&
      !pausedInbound.json.support;
    record(
      "2. Paused inbound is stored, skips order_parse/support, awaits seller",
      test2Pass,
      `webhook=${pausedInbound.status} aiPaused=${pausedInbound.json.aiPaused} parseStored=${pausedInbound.json.parseStored} skip=${JSON.stringify(pausedRow?.ai_parse_result)} outbound ${outboundBefore}→${outboundAfterPaused} visible=${Boolean(visiblePaused?.id)}`,
    );

    // ----- 4 before resume: second reply extends pause -----
    await new Promise((r) => setTimeout(r, 2500));
    const secondText = `TradeFlow inbox follow-up ${marker}`;
    const sent2 = await apiPost(ownerToken, `/api/inbox/${threadId}/reply`, {
      text: secondText,
    });
    const { data: customerAfterSecond } = await admin
      .from("customers")
      .select("ai_paused_until")
      .eq("id", customerId)
      .maybeSingle();
    const pauseUntil2 = customerAfterSecond?.ai_paused_until;
    const pauseHours2 = hoursFromNow(pauseUntil2);
    const extended =
      Boolean(pauseUntil1) &&
      Boolean(pauseUntil2) &&
      Date.parse(pauseUntil2) > Date.parse(pauseUntil1) &&
      pauseHours2 > 23 &&
      pauseHours2 < 25;
    record(
      "4. Further manual reply extends pause 24h from that send",
      sent2.status === 200 && sent2.json.ok === true && extended,
      `first=${pauseUntil1} second=${pauseUntil2} deltaMs=${pauseUntil1 && pauseUntil2 ? Date.parse(pauseUntil2) - Date.parse(pauseUntil1) : "n/a"} hoursFromNow=${pauseHours2?.toFixed(2)}`,
    );

    // ----- 5. List distinguishes paused vs AI -----
    const { data: pausedCustomer } = await ownerRls
      .from("customers")
      .select("id, phone_e164, ai_paused_until")
      .eq("id", customerId)
      .maybeSingle();
    const { data: otherCustomers } = await ownerRls
      .from("customers")
      .select("id, phone_e164, ai_paused_until")
      .neq("id", customerId)
      .is("deleted_at", null)
      .limit(20);
    const otherUnpaused = (otherCustomers ?? []).some(
      (row) => !row.ai_paused_until || Date.parse(row.ai_paused_until) <= Date.now(),
    );
    const pausedNow =
      pausedCustomer?.ai_paused_until &&
      Date.parse(pausedCustomer.ai_paused_until) > Date.now();
    record(
      "5. Inbox can distinguish paused/human-handled vs AI-covered threads",
      Boolean(pausedNow) && (otherUnpaused || (otherCustomers ?? []).length === 0),
      `pausedBuyer=${pausedCustomer?.phone_e164} until=${pausedCustomer?.ai_paused_until} otherUnpaused=${otherUnpaused} otherCount=${(otherCustomers ?? []).length}`,
    );

    // ----- 3. Resume AI, then a real order runs the pipeline -----
    const resumed = await apiPost(ownerToken, `/api/inbox/${threadId}/resume-ai`, {});
    const { data: customerAfterResume } = await admin
      .from("customers")
      .select("ai_paused_until")
      .eq("id", customerId)
      .maybeSingle();

    const orderInbound = await sendWhatsApp(
      `I'd like one Classic Blue Mug please [${marker}-resume]`,
    );
    await new Promise((r) => setTimeout(r, 2500));

    const { data: orderRow } = orderInbound.json.messageId
      ? await admin
          .from("messages")
          .select("id, ai_parse_result")
          .eq("id", orderInbound.json.messageId)
          .maybeSingle()
      : { data: null };
    const parse = orderRow?.ai_parse_result;
    const draftAction = orderInbound.json.draft?.action;
    const draftOrderId = orderInbound.json.draft?.orderId;
    if (draftOrderId && !priorDraftIds.has(draftOrderId)) {
      createdDraftId = draftOrderId;
    }

    const test3Pass =
      resumed.status === 200 &&
      resumed.json.aiPausedUntil === null &&
      customerAfterResume?.ai_paused_until == null &&
      orderInbound.status === 200 &&
      orderInbound.json.aiPaused !== true &&
      orderInbound.json.parseStored === true &&
      parse?.intent === "order" &&
      (draftAction === "draft_created" || draftAction === "draft_updated");
    record(
      "3. Resume AI clears pause; order inbound runs order_parse and creates a draft",
      test3Pass,
      `resume=${resumed.status} pausedUntil=${customerAfterResume?.ai_paused_until} parseStored=${orderInbound.json.parseStored} intent=${parse?.intent} draft=${draftAction} orderId=${draftOrderId ?? ""}`,
    );

    // ----- 6. Cross-tenant -----
    const OTHER_EMAIL = `inbox-reply-other-${Date.now()}@tradeflow-test.local`;
    await cleanupOtherUser(OTHER_EMAIL);
    const { data: otherUser } = await admin.auth.admin.createUser({
      email: OTHER_EMAIL,
      email_confirm: true,
    });
    await admin.from("businesses").insert({
      owner_user_id: otherUser.user.id,
      name: "Inbox Reply Other Shop",
      slug: `inbox-reply-other-${Date.now()}`,
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
      .eq("thread_id", threadId);
    const otherReply = await apiPost(otherToken, `/api/inbox/${threadId}/reply`, {
      text: "should not send",
    });
    const otherResume = await apiPost(otherToken, `/api/inbox/${threadId}/resume-ai`, {});
    const test6Pass =
      (leaked ?? []).length === 0 &&
      otherReply.status === 404 &&
      otherResume.status === 404;
    record(
      "6. Other tenant cannot see or reply in EK-Pousser_D threads",
      test6Pass,
      `leaked=${(leaked ?? []).length} reply=${otherReply.status} resume=${otherResume.status}`,
    );
    await cleanupOtherUser(OTHER_EMAIL);
  } finally {
    if (customerId) {
      await admin
        .from("customers")
        .update({ ai_paused_until: null })
        .eq("id", customerId);
    }
    if (createdDraftId) {
      await admin
        .from("orders")
        .update({ status: "CANCELLED", reserved_until: null })
        .eq("id", createdDraftId)
        .eq("status", "PENDING_CONFIRMATION");
    }
  }

  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
