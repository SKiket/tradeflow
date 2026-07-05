/**
 * Verifies auth + onboarding flows (Tests 1–3).
 * Requires dev server: npm run dev
 * Run: node scripts/verify-auth-flow.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

function loadEnv() {
  const content = readFileSync(resolve(root, ".env.local"), "utf8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `auth-flow-${Date.now()}@tradeflow-test.local`;
const BUSINESS_NAME = "Auth Test Shop";
const BUSINESS_SLUG = `auth-test-${Date.now()}`;

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function cleanup(email) {
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users?.find((u) => u.email === email);
  if (!user) return;

  const { data: businesses } = await admin
    .from("businesses")
    .select("id")
    .eq("owner_user_id", user.id);

  if (businesses?.length) {
    await admin
      .from("businesses")
      .delete()
      .in(
        "id",
        businesses.map((b) => b.id),
      );
  }

  await admin.auth.admin.deleteUser(user.id);
}

async function signInViaMagicLink(email) {
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: `${BASE}/auth/callback` },
    });

  if (linkError) throw linkError;

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: sessionData, error: verifyError } =
    await client.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "email",
    });

  if (verifyError) throw verifyError;
  return { client, session: sessionData.session, user: sessionData.user };
}

async function test3LoggedOutRedirect() {
  const response = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  const passed =
    (response.status === 307 || response.status === 308) &&
    location.includes("/login");
  record(
    "Test 3: /dashboard while logged out → /login",
    passed,
    `status=${response.status}, location=${location}`,
  );
}

async function test1MagicLinkOnboarding() {
  await cleanup(TEST_EMAIL);

  const { client, user } = await signInViaMagicLink(TEST_EMAIL);

  const { data: beforeBusiness } = await client
    .from("businesses")
    .select("id")
    .eq("owner_user_id", user.id)
    .maybeSingle();

  if (beforeBusiness) {
    record("Test 1: new user has no business before onboarding", false, "business already exists");
    return null;
  }

  const { error: insertError } = await client.from("businesses").insert({
    owner_user_id: user.id,
    name: BUSINESS_NAME,
    slug: BUSINESS_SLUG,
    dispatch_address_line1: "1 Test Street",
    dispatch_city: "London",
    dispatch_postcode: "E1 1AA",
    payout_account_holder_name: "Test Holder",
    payout_sort_code: "12-34-56",
    payout_account_number: "12345678",
  });

  if (insertError) {
    record("Test 1: onboarding INSERT via authenticated client", false, insertError.message);
    return null;
  }

  const { data: business } = await client
    .from("businesses")
    .select("name")
    .eq("owner_user_id", user.id)
    .single();

  const passed = business?.name === BUSINESS_NAME;
  record(
    "Test 1: magic link sign-in + onboarding INSERT",
    passed,
    `business.name=${business?.name ?? "null"}`,
  );

  return { email: TEST_EMAIL, client };
}

async function test2ReturningUserSkipsOnboarding(email) {
  const { client, user } = await signInViaMagicLink(email);

  const { data: business } = await client
    .from("businesses")
    .select("id, name")
    .eq("owner_user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  const hasBusiness = !!business;
  record(
    "Test 2: returning user has existing business row",
    hasBusiness,
    hasBusiness ? `name=${business.name}` : "no business found",
  );

  await client.auth.signOut();

  const { client: client2, user: user2 } = await signInViaMagicLink(email);
  const { data: business2 } = await client2
    .from("businesses")
    .select("id")
    .eq("owner_user_id", user2.id)
    .maybeSingle();

  const skipsOnboarding = !!business2;
  record(
    "Test 2: re-login finds business (skips onboarding)",
    skipsOnboarding,
    skipsOnboarding ? "business exists → /dashboard" : "would show onboarding",
  );

  return skipsOnboarding;
}

async function main() {
  console.log(`Base URL: ${BASE}`);
  console.log(`Test email: ${TEST_EMAIL}\n`);

  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    console.error("Dev server not running. Start with: npm run dev");
    process.exit(1);
  }

  await test3LoggedOutRedirect();
  await test1MagicLinkOnboarding();
  await test2ReturningUserSkipsOnboarding(TEST_EMAIL);

  await cleanup(TEST_EMAIL);

  console.log("\n========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  console.log("\nBusinesses INSERT policy (Step 2, unchanged):");
  console.log(
    '  WITH CHECK (owner_user_id = auth.uid()) — no existing row required',
  );

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
