/**
 * Step 24g — shop/product link sharing in WhatsApp replies.
 * Own tagged shops; mocked AI + Twilio dry-run; never touches ek-pousserd.
 *
 *   node scripts/verify-shop-link-sharing.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
const runId = newRunId("sl");
const tag = runId.replace(/^sl-/, "").slice(0, 10);
const results = [];

function publicAppOrigin() {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://tradeflow-tau-blush.vercel.app").replace(
    /\/$/,
    "",
  );
}
function shopUrl(slug, wa = true) {
  const base = `${publicAppOrigin()}/s/${encodeURIComponent(slug)}`;
  return wa ? `${base}?src=wa` : base;
}
function productUrl(slug, productId, wa = true) {
  const base = `${publicAppOrigin()}/s/${encodeURIComponent(slug)}/p/${encodeURIComponent(productId)}`;
  return wa ? `${base}?src=wa` : base;
}

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function runTsxSnippet(code, timeoutMs = 90_000) {
  const tmp = resolve(root, `scripts/_tmp_sl_${randomUUID().slice(0, 6)}.mts`);
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

function mockSupportReply(partial = {}) {
  return {
    reply: partial.reply ?? "Happy to help with that.",
    escalate_to_seller: partial.escalate_to_seller === true,
    is_return_request: partial.is_return_request === true,
    needs_order_clarification: false,
    return_order_ref: null,
    return_reason: null,
    return_reason_detail: null,
    language: partial.language ?? "en",
    share_link: partial.share_link ?? "none",
    share_product_id: partial.share_product_id ?? null,
  };
}

async function createTaggedShop(opts = {}) {
  const suffix = `${tag}${opts.suffix ?? ""}`.slice(0, 14);
  const email = `sl-${suffix}@example.com`;
  const password = `Sl-${suffix}!aA1`;
  const slug = `sl-${suffix}`;
  if (slug === PILOT_SLUG || slug.startsWith("ek-pousser")) {
    throw new Error("refusing pilot slug");
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
      name: opts.name ?? `SL Shop ${suffix}`,
      slug,
      bio: "Handcrafted soap for everyday wash.",
      stripe_subscription_status: opts.billingStatus ?? "active",
      closed_at: opts.closedAt ?? null,
      shop_link_in_chats: opts.shopLinkMode ?? "ask_and_suggest",
      whatsapp_phone_e164: phoneFromRunId(runId, opts.phoneSlot ?? 1),
      banner_url: null,
      logo_url: null,
    })
    .select("id, slug, name")
    .single();
  if (bErr) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw bErr;
  }
  await assertNotPilotBusiness(admin, business.id, "createTaggedShop");

  let productId = null;
  if (opts.withProduct !== false) {
    const { data: product, error: pErr } = await admin
      .from("products")
      .insert({
        business_id: business.id,
        name: opts.productName ?? "Honey Soap",
        description: "Gentle honey bar",
        price_pence: 650,
        active: true,
        photo_url: null,
      })
      .select("id")
      .single();
    if (pErr) throw pErr;
    productId = product.id;
    await admin.from("product_variants").insert({
      product_id: product.id,
      business_id: business.id,
      label: "100g",
      stock_quantity: opts.stock ?? 12,
      reserved_quantity: 0,
      track_inventory: true,
      low_stock_threshold: 2,
      weight_grams: 100,
    });
  }

  const buyerPhone = phoneFromRunId(runId, (opts.phoneSlot ?? 1) + 10);
  const { data: customer, error: cErr } = await admin
    .from("customers")
    .insert({
      business_id: business.id,
      phone_e164: buyerPhone,
      preferred_language: opts.lang ?? "en",
    })
    .select("id")
    .single();
  if (cErr) throw cErr;

  return {
    userId,
    business,
    productId,
    customerId: customer.id,
    threadId: randomUUID(),
    buyerPhone,
    email,
  };
}

function runHandleQuestion(shop, messageText, override) {
  const out = runTsxSnippet(`
    import { createClient } from "@supabase/supabase-js";
    import { handleQuestionReply } from "../src/lib/support/handle-inbound.ts";
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const outcome = await handleQuestionReply({
      businessId: ${JSON.stringify(shop.business.id)},
      customerId: ${JSON.stringify(shop.customerId)},
      customerPhoneE164: ${JSON.stringify(shop.buyerPhone)},
      threadId: ${JSON.stringify(shop.threadId)},
      messageText: ${JSON.stringify(messageText)},
      supabase: admin,
      supportReplyOverride: ${JSON.stringify(override)},
    });
    console.log(JSON.stringify({ reply: outcome.reply, action: outcome.action, ok: outcome.buyerSend?.ok }));
  `);
  if (out.status !== 0) {
    return {
      error: (out.stderr || out.stdout || "handleQuestionReply failed").slice(0, 400),
    };
  }
  const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return { error: `bad json: ${line}` };
  }
}

function runHandleOther(shop, messageText) {
  const out = runTsxSnippet(`
    import { createClient } from "@supabase/supabase-js";
    import { handleOtherFallback } from "../src/lib/support/handle-inbound.ts";
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const outcome = await handleOtherFallback({
      businessId: ${JSON.stringify(shop.business.id)},
      customerId: ${JSON.stringify(shop.customerId)},
      customerPhoneE164: ${JSON.stringify(shop.buyerPhone)},
      threadId: ${JSON.stringify(shop.threadId)},
      messageText: ${JSON.stringify(messageText)},
      supabase: admin,
    });
    console.log(JSON.stringify({ reply: outcome.reply, action: outcome.action }));
  `);
  if (out.status !== 0) {
    return { error: (out.stderr || out.stdout || "").slice(0, 400) };
  }
  const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return { error: `bad json: ${line}` };
  }
}

async function main() {
  console.log(`=== verify-shop-link-sharing runId=${runId} BASE=${BASE} ===`);
  const shops = [];

  try {
    // Unit: detection + strip (via tsx so path aliases resolve)
    const unitOut = runTsxSnippet(`
      import {
        detectExplicitShopLinkRequest,
        detectGreeting,
        detectLinkOptOut,
        parseShopLinkMode,
        stripInventedUrls,
      } from "../src/lib/support/shop-link-share.ts";
      const allowed = "https://example.test/s/x?src=wa";
      const stripped = stripInventedUrls(
        \`See https://evil.test/phish and \${allowed}\`,
        [allowed],
      );
      console.log(JSON.stringify({
        explicit:
          detectExplicitShopLinkRequest("Can I see your website catalogue?") &&
          detectExplicitShopLinkRequest("Envoyez-moi le lien de votre boutique") &&
          detectGreeting("Bonjour") &&
          detectLinkOptOut("stop"),
        strip: !stripped.includes("evil.test") && stripped.includes(allowed),
        mode:
          parseShopLinkMode(null) === "ask_and_suggest" &&
          parseShopLinkMode("off") === "off",
      }));
    `);
    const unitLine = (unitOut.stdout || "").trim().split("\n").filter(Boolean).pop();
    let unit = {};
    try {
      unit = JSON.parse(unitLine || "{}");
    } catch {
      unit = {};
    }
    record("unit: explicit EN+FR detection", unit.explicit === true, unitOut.stderr?.slice(0, 120));
    record("unit: strip invented URL keeps allowlisted", unit.strip === true);
    record("unit: parseShopLinkMode default", unit.mode === true);

    const shopA = await createTaggedShop({ suffix: "a", phoneSlot: 1 });
    shops.push(shopA);
    const shopB = await createTaggedShop({
      suffix: "b",
      phoneSlot: 2,
      name: `SL Shop B ${tag}`,
      productName: "Mint Soap",
    });
    shops.push(shopB);
    // Dedicated shop for suggested-link limits (must not already have ?src=wa).
    const shopS = await createTaggedShop({ suffix: "s", phoneSlot: 4 });
    shops.push(shopS);

    const expectedShopA = shopUrl(shopA.business.slug, true);
    const expectedProductA = productUrl(shopA.business.slug, shopA.productId, true);
    const expectedShopB = shopUrl(shopB.business.slug, true);
    const expectedShopS = shopUrl(shopS.business.slug, true);

    // Suggested greeting (before any other shares on this shop)
    const greet1 = runHandleOther(shopS, "Hello");
    record(
      "suggested: greeting includes shop link",
      Boolean(greet1.reply) && greet1.reply.includes(expectedShopS),
      greet1.error || greet1.reply?.slice(0, 180),
    );
    await admin.from("messages").insert({
      business_id: shopS.business.id,
      customer_id: shopS.customerId,
      thread_id: shopS.threadId,
      channel: "whatsapp",
      direction: "outbound",
      normalised_text: `Here's our shop: ${expectedShopS}`,
    });
    const greet2 = runHandleOther(shopS, "Hi");
    record(
      "suggested: second greeting within 24h has no link",
      Boolean(greet2.reply) && !greet2.reply.includes("?src=wa"),
      greet2.error || greet2.reply?.slice(0, 180),
    );

    // Open draft blocks suggested — fresh thread on shopS
    const draftThreadId = randomUUID();
    const { data: draft, error: draftErr } = await admin
      .from("orders")
      .insert({
        business_id: shopS.business.id,
        customer_id: shopS.customerId,
        thread_id: draftThreadId,
        channel: "whatsapp",
        status: "PENDING_CONFIRMATION",
        order_ref: `TF-SL${tag.slice(0, 6).toUpperCase()}`,
        total_pence: 650,
      })
      .select("id")
      .single();
    if (draftErr) throw draftErr;
    const shopSDraft = { ...shopS, threadId: draftThreadId };
    // Clear cooldown on draft thread (no prior messages)
    const blockedDraft = runHandleOther(shopSDraft, "Hello");
    record(
      "suggested: blocked while open order draft",
      Boolean(blockedDraft.reply) && !blockedDraft.reply.includes("?src=wa"),
      blockedDraft.error || blockedDraft.reply?.slice(0, 160),
    );
    await admin.from("orders").delete().eq("id", draft.id);

    // Explicit EN
    const en = runHandleQuestion(
      shopA,
      "Please send your website / catalogue",
      mockSupportReply({
        reply: "Sure — I can help you browse.",
        share_link: "none",
        language: "en",
      }),
    );
    record(
      "explicit EN gets shop link with slug + ?src=wa",
      Boolean(en.reply) &&
        en.reply.includes(expectedShopA) &&
        en.reply.includes(shopA.business.slug) &&
        /\?src=wa/.test(en.reply) &&
        !en.reply.includes(expectedShopB),
      en.error || en.reply?.slice(0, 180),
    );

    // Explicit FR
    await admin
      .from("customers")
      .update({ preferred_language: "fr" })
      .eq("id", shopA.customerId);
    const fr = runHandleQuestion(
      shopA,
      "Envoyez-moi le lien du catalogue s'il vous plaît",
      mockSupportReply({
        reply: "Bien sûr.",
        share_link: "none",
        language: "fr",
      }),
    );
    record(
      "explicit FR gets shop link + FR line",
      Boolean(fr.reply) &&
        fr.reply.includes(expectedShopA) &&
        /Voici notre boutique/i.test(fr.reply),
      fr.error || fr.reply?.slice(0, 180),
    );
    await admin
      .from("customers")
      .update({ preferred_language: "en" })
      .eq("id", shopA.customerId);

    // Product question
    const productQ = runHandleQuestion(
      shopA,
      "Tell me about Honey Soap",
      mockSupportReply({
        reply: "Honey Soap is a gentle bar.",
        share_link: "product",
        share_product_id: shopA.productId,
        language: "en",
      }),
    );
    record(
      "product question gets product link",
      Boolean(productQ.reply) &&
        productQ.reply.includes(expectedProductA) &&
        productQ.reply.includes(`/p/${shopA.productId}`),
      productQ.error || productQ.reply?.slice(0, 200),
    );

    // Invented URL stripped
    const invented = runHandleQuestion(
      shopA,
      "What soap do you have?",
      mockSupportReply({
        reply: "Check https://totally-fake.example/catalog for deals",
        share_link: "none",
        language: "en",
      }),
    );
    record(
      "invented URL stripped from model reply",
      Boolean(invented.reply) &&
        !invented.reply.includes("totally-fake.example") &&
        !/https?:\/\//i.test(invented.reply.replace(expectedShopA, "")),
      invented.error || invented.reply?.slice(0, 200),
    );

    // Complaint blocks suggested
    const complaint = runHandleQuestion(
      shopA,
      "I want a refund, this is a complaint",
      mockSupportReply({
        reply: "I'm sorry — the seller will help.",
        escalate_to_seller: true,
        share_link: "none",
        language: "en",
      }),
    );
    record(
      "suggested: not in complaint conversation",
      Boolean(complaint.reply) && !complaint.reply.includes("?src=wa"),
      complaint.error || complaint.reply?.slice(0, 160),
    );

    // Stop opt-out
    const stop = runHandleQuestion(
      shopA,
      "Please send your website",
      mockSupportReply({ reply: "OK.", share_link: "shop", language: "en" }),
    );
    // Override message to include stop — explicit+stop should opt out
    const stop2 = runHandleQuestion(
      shopA,
      "stop — no thanks, don't send links",
      mockSupportReply({ reply: "Understood.", share_link: "shop", language: "en" }),
    );
    record(
      "opt-out: stop / no thanks → no link",
      Boolean(stop2.reply) && !stop2.reply.includes("?src=wa"),
      stop2.error || stop2.reply?.slice(0, 160),
    );
    void stop;

    // Setting Off
    await admin
      .from("businesses")
      .update({ shop_link_in_chats: "off" })
      .eq("id", shopA.business.id);
    const offExplicit = runHandleQuestion(
      shopA,
      "Send me your website link please",
      mockSupportReply({
        reply: "Here you go https://evil.test/x",
        share_link: "shop",
        language: "en",
      }),
    );
    record(
      "setting Off: neutral fallback, no link",
      Boolean(offExplicit.reply) &&
        /shop owner can share|propriétaire de la boutique/i.test(offExplicit.reply) &&
        !offExplicit.reply.includes("?src=wa") &&
        !offExplicit.reply.includes("evil.test"),
      offExplicit.error || offExplicit.reply?.slice(0, 200),
    );
    await admin
      .from("businesses")
      .update({ shop_link_in_chats: "ask_and_suggest" })
      .eq("id", shopA.business.id);

    // Suspended / closed shop
    await admin
      .from("businesses")
      .update({ closed_at: new Date().toISOString() })
      .eq("id", shopA.business.id);
    const closed = runHandleQuestion(
      shopA,
      "Send me your catalogue website",
      mockSupportReply({ reply: "Hello.", share_link: "shop", language: "en" }),
    );
    record(
      "closed/suspended shop: no link",
      Boolean(closed.reply) && !closed.reply.includes("?src=wa"),
      closed.error || closed.reply?.slice(0, 160),
    );
    await admin
      .from("businesses")
      .update({ closed_at: null })
      .eq("id", shopA.business.id);

    // No active products
    const emptyShop = await createTaggedShop({
      suffix: "e",
      phoneSlot: 3,
      withProduct: false,
    });
    shops.push(emptyShop);
    const empty = runHandleQuestion(
      emptyShop,
      "What's your website?",
      mockSupportReply({ reply: "Hi.", share_link: "shop", language: "en" }),
    );
    record(
      "no active products: no link",
      Boolean(empty.reply) && !empty.reply.includes("?src=wa"),
      empty.error || empty.reply?.slice(0, 160),
    );

    // Tenant isolation: shop B reply never contains shop A slug link
    const bReply = runHandleQuestion(
      shopB,
      "Send your website catalogue",
      mockSupportReply({ reply: "Sure.", share_link: "none", language: "en" }),
    );
    record(
      "tenant isolation: shop A link never in shop B chat",
      Boolean(bReply.reply) &&
        bReply.reply.includes(expectedShopB) &&
        !bReply.reply.includes(shopA.business.slug),
      bReply.error || bReply.reply?.slice(0, 180),
    );

    // Access audit: signed-out /dashboard
    const dash = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
    const loc = dash.headers.get("location") || "";
    record(
      "access: signed-out /dashboard redirects to login",
      dash.status >= 300 && dash.status < 400 && /login/i.test(loc),
      `status=${dash.status} loc=${loc}`,
    );

    // Storefront public HTML has no private fields
    const sf = await fetch(`${BASE}/s/${shopA.business.slug}`);
    const html = await sf.text();
    const privateHits = [
      "stripe_customer_id",
      "stripe_subscription_id",
      "owner_user_id",
      "SUPABASE_SERVICE_ROLE",
      "whatsapp_access_token",
      "dispatch_address",
    ].filter((k) => html.includes(k));
    record(
      "access: storefront HTML has no private fields",
      sf.status === 200 && privateHits.length === 0,
      `status=${sf.status} hits=${privateHits.join(",") || "none"}`,
    );

    // Product page OG / reachable
    const pp = await fetch(
      `${BASE}/s/${shopA.business.slug}/p/${shopA.productId}`,
    );
    const ppHtml = await pp.text();
    record(
      "product page: reachable + og tags",
      pp.status === 200 &&
        /og:title|property="og:title"/i.test(ppHtml) &&
        /twitter:card/i.test(ppHtml),
      `status=${pp.status}`,
    );

    // Buyer language: FR reply when preferred FR
    await admin
      .from("customers")
      .update({ preferred_language: "fr" })
      .eq("id", shopB.customerId);
    const frLang = runHandleOther(shopB, "xyzzy not a greeting");
    record(
      "every buyer message gets a reply in their language (FR fallback)",
      Boolean(frLang.reply) &&
        /Désolé|commande/i.test(frLang.reply) &&
        frLang.reply.length > 0,
      frLang.error || frLang.reply?.slice(0, 160),
    );

    const offUnit = runTsxSnippet(`
      import { createClient } from "@supabase/supabase-js";
      import {
        applyShopLinkToReply,
        resolveShopLinkShare,
      } from "../src/lib/support/shop-link-share.ts";
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const offDecision = await resolveShopLinkShare({
        businessId: ${JSON.stringify(shopA.business.id)},
        threadId: ${JSON.stringify(shopA.threadId)},
        customerId: ${JSON.stringify(shopA.customerId)},
        messageText: "website please",
        lang: "en",
        mode: "off",
        aiShare: { share_link: "shop", share_product_id: null },
        supabase: admin,
      });
      const offApplied = applyShopLinkToReply({
        reply: "ignored",
        decision: offDecision,
        lang: "en",
      });
      console.log(JSON.stringify({
        ok:
          offDecision.useOffNeutral &&
          /shop owner can share/i.test(offApplied.reply) &&
          !offApplied.sharedUrl,
      }));
    `);
    const offLine = (offUnit.stdout || "").trim().split("\n").filter(Boolean).pop();
    let offParsed = { ok: false };
    try {
      offParsed = JSON.parse(offLine || "{}");
    } catch {
      offParsed = { ok: false };
    }
    record(
      "unit: off + explicit → neutral via applyShopLinkToReply",
      offParsed.ok === true,
      offUnit.stderr?.slice(0, 160),
    );

    record(
      "url builders use publicAppOrigin",
      expectedShopA.startsWith(publicAppOrigin()) &&
        expectedProductA.startsWith(publicAppOrigin()),
      publicAppOrigin(),
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
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed (${results.length} total) ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
