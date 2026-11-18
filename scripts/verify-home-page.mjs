/**
 * Step 24f — root home page replaces create-next-app starter.
 * Own tagged shop for signed-in redirect; never touches ek-pousserd.
 *
 *   node scripts/verify-home-page.mjs
 */
import { createBrowserClient } from "@supabase/ssr";
import {
  assertNotPilotBusiness,
  createAdmin,
  deleteTestBusiness,
  loadVerifyEnv,
  newRunId,
  phoneFromRunId,
  PILOT_SLUG,
} from "./lib/verify-harness.mjs";

const env = loadVerifyEnv();
const admin = createAdmin();
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const runId = newRunId("home");
const tag = runId.replace(/^home-/, "").slice(0, 10);
const results = [];
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function mintOwnerCookies(email) {
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
  return cookies;
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function createShop() {
  const email = `home-${tag}@example.com`;
  const password = `Home-${tag}!aA1`;
  const slug = `home-${tag}`;
  if (slug === PILOT_SLUG || slug.startsWith("ek-pousser")) {
    throw new Error("refusing pilot");
  }
  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (uErr) throw uErr;
  const userId = created.user.id;
  const { data: business, error: bErr } = await admin
    .from("businesses")
    .insert({
      owner_user_id: userId,
      name: `Home Shop ${tag}`,
      slug,
      stripe_subscription_status: "active",
      stripe_charges_enabled: true,
      stripe_transfers_capability_active: true,
      stripe_connected_account_id: `acct_home_${tag}`,
      whatsapp_phone_e164: phoneFromRunId(runId, 1),
    })
    .select("id, slug")
    .single();
  if (bErr) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw bErr;
  }
  await assertNotPilotBusiness(admin, business.id, "createShop");
  return { userId, email, business };
}

async function main() {
  console.log("=== verify-home-page (Step 24f) ===");
  console.log(`runId=${runId} BASE=${BASE}`);
  let shop = null;

  try {
    const signedOut = await fetch(`${BASE}/`, {
      redirect: "manual",
      headers: { Accept: "text/html", "Accept-Language": "en-GB" },
    });
    const html = await signedOut.text();
    const noStarter =
      !/To get started, edit the page\.tsx/i.test(html) &&
      !/Deploy Now/i.test(html) &&
      !/create-next-app/i.test(html) &&
      !/Create Next App/i.test(html);
    const hasBrand =
      /TradeFlow/i.test(html) &&
      /Sell on WhatsApp\. Get paid\. Stay in control\./i.test(html);
    const hasSignIn =
      /data-tf-home-signin/i.test(html) && /href="\/login"/i.test(html);
    const hasLegal =
      /Privacy/i.test(html) &&
      /Terms/i.test(html) &&
      /copalla\.com\/privacy/i.test(html) &&
      /copalla\.com\/terms/i.test(html);
    record(
      "1. signed-out / is 200 branded page (no starter)",
      signedOut.status === 200 && noStarter && hasBrand && hasSignIn && hasLegal,
      `status=${signedOut.status} noStarter=${noStarter} brand=${hasBrand} signIn=${hasSignIn} legal=${hasLegal}`,
    );

    const fr = await fetch(`${BASE}/`, {
      redirect: "manual",
      headers: { Accept: "text/html", "Accept-Language": "fr-FR,fr;q=0.9" },
    });
    const frHtml = await fr.text();
    record(
      "1b. Accept-Language fr shows French tagline",
      fr.status === 200 &&
        /Vendez sur WhatsApp\. Soyez payé\. Gardez le contrôle\./i.test(frHtml),
      `status=${fr.status}`,
    );

    const login = await fetch(`${BASE}/login`, { redirect: "manual" });
    const loginHtml = await login.text();
    record(
      "2. Sign in target /login returns 200",
      login.status === 200 && /magic link/i.test(loginHtml),
      `status=${login.status}`,
    );

    const privacyHead = await fetch("https://copalla.com/privacy", {
      method: "HEAD",
      redirect: "follow",
    }).catch(() => null);
    const termsHead = await fetch("https://copalla.com/terms", {
      method: "HEAD",
      redirect: "follow",
    }).catch(() => null);
    const privacyOk =
      privacyHead && privacyHead.status >= 200 && privacyHead.status < 400;
    const termsOk =
      termsHead && termsHead.status >= 200 && termsHead.status < 400;
    record(
      "3. Privacy and Terms URLs reachable",
      Boolean(privacyOk && termsOk),
      `privacy=${privacyHead?.status} terms=${termsHead?.status}`,
    );

    shop = await createShop();
    const cookies = await mintOwnerCookies(shop.email);
    const signedIn = await fetch(`${BASE}/`, {
      redirect: "manual",
      headers: {
        Accept: "text/html",
        Cookie: cookieHeader(cookies),
      },
    });
    const loc = signedIn.headers.get("location") ?? "";
    record(
      "4. signed-in / redirects to /dashboard",
      (signedIn.status === 307 || signedIn.status === 303 || signedIn.status === 302) &&
        (/\/dashboard\/?$/.test(loc) || loc.endsWith("/dashboard")),
      `status=${signedIn.status} location=${loc}`,
    );

    console.log("\nLayout notes (no screenshot tooling):");
    console.log(
      "  Phone (~390px): centered column, wordmark, tagline, full-width Sign in, Privacy · Terms.",
    );
    console.log(
      "  Desktop: same composition, max-width 24rem, vertically centered on background.",
    );
  } finally {
    if (shop) {
      try {
        await assertNotPilotBusiness(admin, shop.business.id, "cleanup");
        await deleteTestBusiness(admin, shop.business.id, {
          ownerUserId: shop.userId,
        });
      } catch (e) {
        console.warn("cleanup:", e.message);
      }
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(
    `\n=== Summary: ${results.length - failed} passed, ${failed} failed ===`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
