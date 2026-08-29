/**
 * Verifies /dashboard/settings for EK-Pousser_D:
 *   1. Authenticated page loads with the real businesses row
 *   2. Seller RLS update of returns_policy_text is persisted, then a signed
 *      "what's your return policy?" WhatsApp inbound is answered from the NEW text
 *   3. Stripe headline matches the three cached Connect booleans
 *   4. Tenant A cannot read or write EK-Pousser_D's row
 *
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-settings.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447700900084";
const EK_EMAIL = "sgkiket@gmail.com";
const TENANT_A = {
  email: "tenant-a@tradeflow-test.local",
  password: "TestTenantA!123",
};
const NEW_RETURNS =
  "Returns accepted within 21 days if unused and in original packaging. Settings token SETTINGS-D4-20260829.";

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

function expectedStripeHeadline({ chargesEnabled, detailsSubmitted }) {
  if (chargesEnabled) return "Payments: Active";
  if (detailsSubmitted) return "Payments: Pending Stripe review";
  return "Payments: Setup incomplete";
}

const env = loadEnv();
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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
    ProfileName: "Settings Verifier",
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
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function mintCookies(email, password) {
  const cookies = [];
  const supabase = createBrowserClient(url, anon, {
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
  });

  if (password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  } else {
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
  }

  return { supabase, cookies };
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function fetchSettingsHtml(cookies) {
  const response = await fetch(`${BASE}/dashboard/settings`, {
    headers: { Cookie: cookieHeader(cookies) },
    redirect: "manual",
  });
  const html = await response.text();
  return { status: response.status, location: response.headers.get("location"), html };
}

function userClientFromSession(session) {
  return createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
}

async function cleanBuyerState(businessId) {
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", BUYER);
  const ids = (customers ?? []).map((c) => c.id);
  if (!ids.length) return;
  await admin.from("messages").delete().in("customer_id", ids);
  await admin.from("customers").delete().in("id", ids);
}

async function main() {
  const { data: ek, error: ekError } = await admin
    .from("businesses")
    .select(
      "id, name, owner_user_id, dispatch_address_line1, dispatch_city, dispatch_postcode, returns_policy_text, ai_tone, default_low_stock_threshold, stripe_connected_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, whatsapp_phone_e164",
    )
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (ekError) throw new Error(ekError.message);
  if (!ek) throw new Error("EK-Pousser_D not found");

  const originalReturns = ek.returns_policy_text;
  const stripeHeadline = expectedStripeHeadline({
    chargesEnabled: Boolean(ek.stripe_charges_enabled),
    detailsSubmitted: Boolean(ek.stripe_details_submitted),
  });

  console.log(`Business: ${ek.name} (${ek.id})`);
  console.log(`Dispatch: ${ek.dispatch_address_line1}, ${ek.dispatch_city} ${ek.dispatch_postcode}`);
  console.log(`Returns (current): ${originalReturns}`);
  console.log(`AI tone: ${ek.ai_tone}`);
  console.log(`Default low-stock: ${ek.default_low_stock_threshold}`);
  console.log(
    `Stripe flags: charges=${ek.stripe_charges_enabled} payouts=${ek.stripe_payouts_enabled} details=${ek.stripe_details_submitted} acct=${ek.stripe_connected_account_id}`,
  );
  console.log(`Expected Stripe headline: ${stripeHeadline}`);
  console.log(`WhatsApp: ${ek.whatsapp_phone_e164}\n`);

  const ekSession = await mintCookies(EK_EMAIL);
  const page1 = await fetchSettingsHtml(ekSession.cookies);
  const loadPass =
    page1.status === 200 &&
    page1.html.includes("Settings") &&
    page1.html.includes(ek.name) &&
    (ek.dispatch_address_line1
      ? page1.html.includes(ek.dispatch_address_line1)
      : true) &&
    (originalReturns ? page1.html.includes(originalReturns) : true) &&
    page1.html.includes(stripeHeadline) &&
    (ek.stripe_connected_account_id
      ? page1.html.includes(ek.stripe_connected_account_id)
      : true) &&
    (ek.whatsapp_phone_e164
      ? page1.html.includes(ek.whatsapp_phone_e164)
      : page1.html.includes("WhatsApp: Not connected")) &&
    page1.html.includes("Save settings") &&
    !page1.html.includes(">Soon<");
  record(
    "1. EK-Pousser_D /dashboard/settings loads real current values",
    loadPass,
    `status=${page1.status} location=${page1.location ?? ""} htmlLength=${page1.html.length}`,
  );

  const {
    data: { session: ekAuth },
  } = await ekSession.supabase.auth.getSession();
  if (!ekAuth) throw new Error("EK-Pousser_D session missing");
  const ekClient = userClientFromSession(ekAuth);

  try {
    const { data: saved, error: saveError } = await ekClient
      .from("businesses")
      .update({ returns_policy_text: NEW_RETURNS })
      .eq("id", ek.id)
      .select("id, returns_policy_text")
      .maybeSingle();
    const { data: afterSave } = await admin
      .from("businesses")
      .select("returns_policy_text")
      .eq("id", ek.id)
      .single();
    const dbUpdated =
      !saveError &&
      saved?.returns_policy_text === NEW_RETURNS &&
      afterSave?.returns_policy_text === NEW_RETURNS;
    record(
      "2a. Authenticated seller update persisted returns_policy_text",
      dbUpdated,
      saveError
        ? saveError.message
        : `db=${JSON.stringify(afterSave?.returns_policy_text)}`,
    );

    await cleanBuyerState(ek.id);
    const inbound = await sendWhatsApp("what's your return policy?");
    const support = inbound.json.support;
    const reply = support?.reply ?? "";
    const replyPass =
      inbound.status === 200 &&
      inbound.json.parseStored === true &&
      support?.action === "answered" &&
      support?.escalateToSeller === false &&
      support?.aiCalled === true &&
      (/21\s*days/i.test(reply) ||
        /twenty[-\s]?one/i.test(reply) ||
        /SETTINGS-D4-20260829/i.test(reply) ||
        /original packaging/i.test(reply)) &&
      !/14\s*days/i.test(reply);
    record(
      "2b. Signed return-policy WhatsApp answered from NEW settings text",
      replyPass,
      `status=${inbound.status} action=${support?.action} escalate=${support?.escalateToSeller}\nreply=${reply}`,
    );
  } finally {
    await admin
      .from("businesses")
      .update({ returns_policy_text: originalReturns })
      .eq("id", ek.id);
    await cleanBuyerState(ek.id);
  }

  const stripePass =
    page1.status === 200 &&
    page1.html.includes(stripeHeadline) &&
    (ek.stripe_charges_enabled
      ? page1.html.includes("Charges") && page1.html.includes("Enabled")
      : true);
  record(
    "3. Stripe panel wording matches cached Connect booleans",
    stripePass,
    `headline=${stripeHeadline} charges=${ek.stripe_charges_enabled} payouts=${ek.stripe_payouts_enabled} details=${ek.stripe_details_submitted}`,
  );

  const tenantSession = await mintCookies(TENANT_A.email);
  const tenantPage = await fetchSettingsHtml(tenantSession.cookies);
  const {
    data: { session: tenantAuth },
  } = await tenantSession.supabase.auth.getSession();
  if (!tenantAuth) throw new Error("Tenant A session missing");
  const tenantClient = userClientFromSession(tenantAuth);

  const { data: leaked } = await tenantClient
    .from("businesses")
    .select("id, name, returns_policy_text")
    .eq("id", ek.id)
    .maybeSingle();
  const { data: tenantOwn } = await tenantClient
    .from("businesses")
    .select("id, name")
    .maybeSingle();
  const { data: tenantUpdate, error: tenantUpdateError } = await tenantClient
    .from("businesses")
    .update({ returns_policy_text: "TENANT_A_SHOULD_NOT_WRITE_THIS" })
    .eq("id", ek.id)
    .select("id")
    .maybeSingle();
  const { data: ekAfterLeak } = await admin
    .from("businesses")
    .select("returns_policy_text")
    .eq("id", ek.id)
    .single();

  const isolated =
    tenantPage.status === 200 &&
    tenantPage.html.includes("Tenant A") &&
    !tenantPage.html.includes(ek.name) &&
    !(originalReturns && tenantPage.html.includes(originalReturns)) &&
    !leaked &&
    tenantOwn?.name === "Tenant A" &&
    !tenantUpdate &&
    ekAfterLeak?.returns_policy_text === originalReturns;
  record(
    "4. Tenant A cannot read or write EK-Pousser_D settings",
    isolated,
    `tenantPage=${tenantPage.status} leaked=${JSON.stringify(leaked)} own=${tenantOwn?.name} update=${JSON.stringify(tenantUpdate)} updateError=${tenantUpdateError?.message ?? ""} ekReturnsUnchanged=${ekAfterLeak?.returns_policy_text === originalReturns}`,
  );

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
