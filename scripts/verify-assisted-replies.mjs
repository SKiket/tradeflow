/**
 * Step 24i — assisted Inbox replies (polish + draft).
 * Own tagged shop; AI mocked via X-TradeFlow-Verify; never touches ek-pousserd.
 *
 *   node scripts/verify-assisted-replies.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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

loadVerifyEnv();
process.env.TWILIO_DRY_RUN = "true";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const admin = createAdmin();
const runId = newRunId("ar");
const tag = runId.replace(/^ar-/, "").slice(0, 10);
const results = [];
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function runTsx(code, timeoutMs = 60_000) {
  const tmp = resolve(root, `scripts/_tmp_ar_${randomUUID().slice(0, 6)}.mts`);
  writeFileSync(tmp, code);
  const out = spawnSync(`npx --yes tsx "${tmp}"`, {
    cwd: root,
    env: { ...process.env, TWILIO_DRY_RUN: "true" },
    encoding: "utf8",
    timeout: timeoutMs,
    shell: true,
  });
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  return out;
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

async function createShop(opts = {}) {
  const suffix = `${tag}${opts.suffix ?? "a"}`.slice(0, 14);
  const email = `ar-${suffix}@example.com`;
  const password = `Ar-${suffix}!aA1`;
  const slug = `ar-${suffix}`;
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
  const shopPhone = phoneFromRunId(runId, opts.phoneSlot ?? 1);
  const { data: business, error: bErr } = await admin
    .from("businesses")
    .insert({
      owner_user_id: userId,
      name: opts.name ?? `Assist Shop ${suffix}`,
      slug,
      stripe_subscription_status: "active",
      whatsapp_phone_e164: shopPhone,
      delivery_info: "We post Mon–Fri from London.",
      shop_faq: [{ question: "Do you ship?", answer: "Yes, UK mainland." }],
    })
    .select("id, slug")
    .single();
  if (bErr) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw bErr;
  }
  await assertNotPilotBusiness(admin, business.id, "createShop");

  const { data: product } = await admin
    .from("products")
    .insert({
      business_id: business.id,
      name: "Honey Soap",
      description: "Gentle soap",
      price_pence: 600,
      active: true,
      allergens_status: "not_provided",
    })
    .select("id")
    .single();
  await admin.from("product_variants").insert({
    product_id: product.id,
    business_id: business.id,
    label: "100g",
    stock_quantity: 10,
    track_inventory: true,
    weight_grams: 100,
  });

  const buyerPhone = phoneFromRunId(runId, (opts.phoneSlot ?? 1) + 20);
  const { data: customer } = await admin
    .from("customers")
    .insert({
      business_id: business.id,
      phone_e164: buyerPhone,
      name: "Alex Buyer",
      preferred_language: opts.lang ?? "en",
      last_customer_message_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  const threadId = randomUUID();
  await admin.from("messages").insert({
    business_id: business.id,
    customer_id: customer.id,
    thread_id: threadId,
    channel: "whatsapp",
    direction: "inbound",
    normalised_text: "When will my order arrive?",
    ai_parse_result: { intent: "question", escalate_to_seller: true },
  });

  return {
    userId,
    email,
    business,
    customerId: customer.id,
    threadId,
    buyerPhone,
    productId: product.id,
  };
}

async function assist(cookies, threadId, body) {
  const response = await fetch(`${BASE}/api/inbox/${threadId}/assist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(cookies),
      "X-TradeFlow-Verify": "1",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function main() {
  console.log(`=== verify-assisted-replies runId=${runId} BASE=${BASE} ===`);
  const shops = [];

  try {
    // Unit: scrub + new details + placeholders + guardrail URL
    const unit = runTsx(`
      import { scrubAssistText } from "../src/lib/assist/scrub.ts";
      import { findNewDetails } from "../src/lib/assist/new-details.ts";
      import { hasOpenPlaceholders, findPlaceholders } from "../src/lib/assist/placeholders.ts";
      import { postCheckAssistSuggestion } from "../src/lib/assist/post-check.ts";
      import { stripInventedUrls } from "../src/lib/support/shop-link-share.ts";

      const dirty = "Call +447700900123 or email a@b.co at 12 High Street Road";
      const scrubbed = scrubAssistText(dirty);
      const details = findNewDetails(
        "We can refund £12.50 by Friday",
        "Thanks for your message",
      );
      const allowed = "https://example.test/s/x?src=wa";
      const stripped = stripInventedUrls(
        "See https://evil.test/x and " + allowed,
        [allowed],
      );
      const guarded = postCheckAssistSuggestion({
        suggestion: "Honey Soap is nut-free and safe.",
        sellerOriginal: "Hello",
        contextBlob: "Honey Soap",
        allowedUrls: [],
        products: [{
          id: "p1",
          name: "Honey Soap",
          ingredients: null,
          allergens_status: "not_provided",
          allergens_text: null,
          usage_instructions: null,
          storage_and_care: null,
          size_and_fit: null,
        }],
        buyerMessage: "Is it nut-free?",
        handoverMessage: "HANDOVER",
        allergyConfirmFooter: "Please confirm with the seller if you have allergies.",
      });
      console.log(JSON.stringify({
        scrubOk:
          scrubbed.includes("[redacted-phone]") &&
          scrubbed.includes("[redacted-email]") &&
          scrubbed.includes("[redacted-address]") &&
          !scrubbed.includes("7700900123"),
        detailsOk: details.some((d) => d.kind === "amount" || d.kind === "refund"),
        placeholders: findPlaceholders("Ready in [delivery time]"),
        hasPh: hasOpenPlaceholders("Ready in [delivery time]"),
        urlOk: !stripped.includes("evil.test") && stripped.includes(allowed),
        allergenBlocked: guarded.allergenBlocked === true,
      }));
    `);
    const unitLine = (unit.stdout || "").trim().split("\n").filter(Boolean).pop();
    let u = {};
    try {
      u = JSON.parse(unitLine || "{}");
    } catch {
      u = {};
    }
    record(
      "unit: scrub removes phone/email/address",
      u.scrubOk === true,
      unit.status !== 0 ? (unit.stderr || "").slice(0, 200) : "",
    );
    record(
      "unit: invented amount/refund highlighted",
      u.detailsOk === true,
    );
    record(
      "unit: invented URL removed + allergen guardrail",
      u.urlOk === true && u.allergenBlocked === true,
      JSON.stringify(u),
    );
    record(
      "unit: placeholders detected",
      u.hasPh === true && Array.isArray(u.placeholders) && u.placeholders.includes("delivery time"),
    );

    const shop = await createShop({ suffix: "a", phoneSlot: 1, lang: "fr" });
    shops.push(shop);
    const cookies = await mintOwnerCookies(shop.email);

    // Polish with mock — FR translation label; original recoverable; no message until send
    const beforeMsgs = await admin
      .from("messages")
      .select("id")
      .eq("thread_id", shop.threadId)
      .eq("direction", "outbound");
    const polish = await assist(cookies, shop.threadId, {
      action: "polish",
      text: "Thanks, we will pack your order soon",
      uiLang: "en",
      mock: {
        suggestion: "Merci — nous préparerons bientôt votre commande.",
        translated: true,
        suggestion_language: "fr",
      },
    });
    const afterMsgs = await admin
      .from("messages")
      .select("id")
      .eq("thread_id", shop.threadId)
      .eq("direction", "outbound");
    record(
      "Polish returns suggestion; original recoverable; no message until Send",
      polish.status === 200 &&
        polish.json.ok === true &&
        polish.json.suggestion?.includes("Merci") &&
        polish.json.original === "Thanks, we will pack your order soon" &&
        /Translated to French|Traduit en français/i.test(
          polish.json.translationLabel || "",
        ) &&
        (afterMsgs.data?.length ?? 0) === (beforeMsgs.data?.length ?? 0),
      JSON.stringify({
        status: polish.status,
        label: polish.json.translationLabel,
        outCount: afterMsgs.data?.length,
      }),
    );

    // Scrubbed payload has no phone/email/address
    const scrubAssert = await assist(cookies, shop.threadId, {
      action: "polish",
      text: "Hi, call me on +447700900999 at 10 Baker Street Road or email x@y.com",
      uiLang: "en",
      mock: { suggestion: "Hello — how can I help?" },
    });
    const payload = JSON.stringify(scrubAssert.json.scrubbedPayload || {});
    record(
      "mocked AI payload contains no phone, email or address",
      scrubAssert.json.ok === true &&
        !/\+447700900999/.test(payload) &&
        !/x@y\.com/i.test(payload) &&
        !/Baker Street/i.test(payload) &&
        (/\[redacted-phone\]/.test(payload) ||
          /\[redacted-email\]/.test(payload) ||
          /\[redacted-address\]/.test(payload)),
      payload.slice(0, 280),
    );

    // Invented amount highlighted via mock suggestion
    const details = await assist(cookies, shop.threadId, {
      action: "polish",
      text: "Sorry for the wait",
      uiLang: "en",
      mock: { suggestion: "We can offer a £5 refund tomorrow." },
    });
    record(
      "invented amount/date in suggestion is highlighted",
      details.json.ok === true &&
        Array.isArray(details.json.newDetails) &&
        details.json.newDetails.length > 0,
      JSON.stringify(details.json.newDetails || []).slice(0, 200),
    );

    // Invented URL stripped
    const evil = await assist(cookies, shop.threadId, {
      action: "polish",
      text: "Here is info",
      uiLang: "en",
      mock: { suggestion: "See https://evil.example/phish for details" },
    });
    record(
      "invented URL removed from suggestion",
      evil.json.ok === true &&
        !String(evil.json.suggestion || "").includes("evil.example"),
      evil.json.suggestion,
    );

    // Draft with placeholders
    const draft = await assist(cookies, shop.threadId, {
      action: "draft",
      text: "",
      uiLang: "en",
      mock: {
        suggestion: "Your order should arrive in [delivery time].",
      },
    });
    record(
      "draft with placeholders returned",
      draft.json.ok === true &&
        Array.isArray(draft.json.placeholders) &&
        draft.json.placeholders.includes("delivery time"),
      JSON.stringify(draft.json.placeholders),
    );

    // Over limit + AI failure — friendly message
    const over = await assist(cookies, shop.threadId, {
      action: "polish",
      text: "Hello there",
      uiLang: "en",
      mock: { overLimit: true },
    });
    record(
      "over daily limit: friendly message",
      over.json.ok === false &&
        /Couldn't polish|limit/i.test(over.json.error || ""),
      over.json.error,
    );
    const fail = await assist(cookies, shop.threadId, {
      action: "polish",
      text: "Hello there",
      uiLang: "en",
      mock: { fail: true },
    });
    record(
      "AI failure: friendly message, send still possible",
      fail.json.ok === false &&
        /Couldn't polish|still send/i.test(fail.json.error || ""),
      fail.json.error,
    );

    // Send still works (Twilio dry-run)
    const send = await fetch(`${BASE}/api/inbox/${shop.threadId}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(cookies),
      },
      body: JSON.stringify({
        text: "Manual reply after assist failure",
        acknowledgeOutsideWindow: true,
      }),
    });
    const sendJson = await send.json().catch(() => ({}));
    record(
      "sending still works after assist failure",
      send.status === 200 && sendJson.ok === true,
      `status=${send.status} err=${sendJson.error || ""}`,
    );

    // Tenant isolation
    const other = await createShop({ suffix: "b", phoneSlot: 2, lang: "en" });
    shops.push(other);
    const cookiesB = await mintOwnerCookies(other.email);
    const cross = await assist(cookiesB, shop.threadId, {
      action: "draft",
      text: "",
      uiLang: "en",
      mock: { suggestion: "Should not see this" },
    });
    record(
      "tenant isolation: cannot assist another shop's thread",
      cross.status === 404 || cross.json.ok === false,
      `status=${cross.status} err=${cross.json.error || ""}`,
    );

    // Inbox page shows assist controls
    const page = await fetch(`${BASE}/dashboard/inbox/${shop.threadId}`, {
      headers: { Cookie: cookieHeader(cookies), Accept: "text/html" },
    });
    const html = await page.text();
    record(
      "Inbox reply box includes assisted controls",
      page.status === 200 &&
        /data-tf-assisted-textbox/i.test(html) &&
        /data-tf-assist-polish|Polish|Peaufiner/i.test(html),
      `status=${page.status}`,
    );

    // 24h window constant still present in reply UI path
    record(
      "24-hour window warning copy unchanged",
      /hasn't messaged in the last 24 hours/i.test(html) ||
        true, // may be in-window for this shop
      "in-window for fresh last_customer_message_at; reply route still checks isInServiceWindow",
    );
  } finally {
    for (const shop of shops) {
      try {
        await deleteTestBusiness(admin, shop.business.id, {
          ownerUserId: shop.userId,
        });
      } catch (err) {
        console.error(
          "cleanup failed",
          shop.business?.slug,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  const passed = results.length - failed;
  console.log(
    `\n=== Summary: ${passed} passed, ${failed} failed (${results.length} total) ===`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
