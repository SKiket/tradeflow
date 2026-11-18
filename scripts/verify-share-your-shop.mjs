/**
 * Step 24h — Share your shop screen.
 * Own tagged shops; never touches ek-pousserd.
 *
 *   node scripts/verify-share-your-shop.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createBrowserClient } from "@supabase/ssr";
import QRCode from "qrcode";
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
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const admin = createAdmin();
const runId = newRunId("sys");
const tag = runId.replace(/^sys-/, "").slice(0, 10);
const results = [];
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP_ORIGIN = (
  process.env.NEXT_PUBLIC_APP_URL || "https://tradeflow-tau-blush.vercel.app"
).replace(/\/$/, "");

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function runTsx(code, timeoutMs = 60_000) {
  const tmp = resolve(root, `scripts/_tmp_sys_${randomUUID().slice(0, 6)}.mts`);
  writeFileSync(tmp, code);
  const out = spawnSync(`npx --yes tsx "${tmp}"`, {
    cwd: root,
    env: process.env,
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
  const suffix = `${tag}${opts.suffix ?? ""}`.slice(0, 14);
  const email = `sys-${suffix}@example.com`;
  const password = `Sys-${suffix}!aA1`;
  const slug = `sys-${suffix}`;
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
  const phone =
    opts.withWhatsApp === false ? null : phoneFromRunId(runId, opts.phoneSlot ?? 1);
  const { data: business, error: bErr } = await admin
    .from("businesses")
    .insert({
      owner_user_id: userId,
      name: opts.name ?? `Share Shop ${suffix}`,
      slug,
      stripe_subscription_status: opts.billingStatus ?? "active",
      closed_at: opts.closedAt ?? null,
      whatsapp_phone_e164: phone,
    })
    .select("id, slug, name, whatsapp_phone_e164")
    .single();
  if (bErr) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw bErr;
  }
  await assertNotPilotBusiness(admin, business.id, "createShop");

  if (opts.withProduct !== false) {
    const { data: product, error: pErr } = await admin
      .from("products")
      .insert({
        business_id: business.id,
        name: "Share Soap",
        description: "Test",
        price_pence: 500,
        active: true,
      })
      .select("id")
      .single();
    if (pErr) throw pErr;
    await admin.from("product_variants").insert({
      product_id: product.id,
      business_id: business.id,
      label: "100g",
      stock_quantity: 5,
      track_inventory: true,
      weight_grams: 100,
    });
  }

  return { userId, email, business, phone };
}

async function main() {
  console.log(`=== verify-share-your-shop runId=${runId} BASE=${BASE} ===`);
  const shops = [];

  try {
    const builders = runTsx(`
      import { shopUrl, productUrl, publicAppOrigin } from "../src/lib/storefront/url.ts";
      const slug = "demo-shop";
      const id = "11111111-1111-1111-1111-111111111111";
      const origin = publicAppOrigin();
      console.log(JSON.stringify({
        none: shopUrl({ slug }),
        link: shopUrl({ slug }, { src: "link" }),
        qr: shopUrl({ slug }, { src: "qr" }),
        social: shopUrl({ slug }, { src: "social" }),
        wa: shopUrl({ slug }, { src: "wa" }),
        productWa: productUrl({ slug }, { id }, { src: "wa" }),
        origin,
      }));
    `);
    const builderLine = (builders.stdout || "").trim().split("\n").filter(Boolean).pop();
    let b = {};
    try {
      b = JSON.parse(builderLine || "{}");
    } catch {
      b = {};
    }
    const noPersonal =
      typeof b.link === "string" &&
      !/\+\d{8,}|@|phone=|email=/i.test(b.link) &&
      !b.link.includes(" ");
    record(
      "link builder: src tags link/qr/social/wa",
      b.link === `${b.origin}/s/demo-shop?src=link` &&
        b.qr === `${b.origin}/s/demo-shop?src=qr` &&
        b.social === `${b.origin}/s/demo-shop?src=social` &&
        b.wa === `${b.origin}/s/demo-shop?src=wa` &&
        b.none === `${b.origin}/s/demo-shop` &&
        String(b.productWa).includes("/p/11111111-1111-1111-1111-111111111111?src=wa") &&
        noPersonal,
      builders.status !== 0
        ? (builders.stderr || builders.stdout || "").slice(0, 300)
        : JSON.stringify(b),
    );

    const shopA = await createShop({ suffix: "a", phoneSlot: 1 });
    shops.push(shopA);
    const qrUrl = `${APP_ORIGIN}/s/${shopA.business.slug}?src=qr`;
    const svg = await QRCode.toString(qrUrl, { type: "svg", margin: 1 });
    record(
      "QR payload equals exact shop URL (generator input)",
      typeof svg === "string" &&
        svg.includes("<svg") &&
        qrUrl.endsWith("?src=qr") &&
        qrUrl.includes(`/s/${shopA.business.slug}`),
      qrUrl,
    );

    const copyCheck = runTsx(`
      import { shareCopy, posterScanLines } from "../src/lib/dashboard/share-copy.ts";
      const en = shareCopy("en");
      const fr = shareCopy("fr");
      const keys = Object.keys(en).filter((k) => typeof en[k] === "string");
      const allFr = keys.every((k) => typeof fr[k] === "string" && fr[k].trim().length > 0);
      console.log(JSON.stringify({
        allFr,
        enTitle: en.pageTitle,
        frTitle: fr.pageTitle,
        navEn: en.navLabel,
        navFr: fr.navLabel,
        posterBoth: posterScanLines(null),
        statusEn: en.statusTemplate("https://x.test/s/a?src=link"),
        statusFr: fr.statusTemplate("https://x.test/s/a?src=link"),
      }));
    `);
    const copyLine = (copyCheck.stdout || "").trim().split("\n").filter(Boolean).pop();
    let c = {};
    try {
      c = JSON.parse(copyLine || "{}");
    } catch {
      c = {};
    }
    record(
      "EN and FR strings present for every label",
      c.allFr === true &&
        c.navEn === "Share" &&
        c.navFr === "Partager" &&
        Array.isArray(c.posterBoth) &&
        c.posterBoth.length >= 2 &&
        /New in the shop/i.test(c.statusEn || "") &&
        /Nouveautés|boutique/i.test(c.statusFr || ""),
      JSON.stringify(c).slice(0, 280),
    );

    const signedOut = await fetch(`${BASE}/dashboard/share`, { redirect: "manual" });
    const loc = signedOut.headers.get("location") || "";
    record(
      "signed-out /dashboard/share redirected",
      signedOut.status >= 300 && signedOut.status < 400 && /login/i.test(loc),
      `status=${signedOut.status} loc=${loc}`,
    );

    const cookiesA = await mintOwnerCookies(shopA.email);
    const pageA = await fetch(`${BASE}/dashboard/share`, {
      redirect: "manual",
      headers: { Cookie: cookieHeader(cookiesA), Accept: "text/html" },
    });
    const htmlA = await pageA.text();
    record(
      "signed-in owner loads Share page with tools",
      pageA.status === 200 &&
        (/data-tf-share-page|data-tf-share-link/i.test(htmlA) ||
          htmlA.includes("?src=link")) &&
        htmlA.includes(shopA.business.slug),
      `status=${pageA.status}`,
    );

    const shopB = await createShop({
      suffix: "b",
      phoneSlot: 2,
      name: `Other Shop ${tag}`,
    });
    shops.push(shopB);
    const cookiesB = await mintOwnerCookies(shopB.email);
    const pageB = await fetch(`${BASE}/dashboard/share`, {
      redirect: "manual",
      headers: { Cookie: cookieHeader(cookiesB), Accept: "text/html" },
    });
    const htmlB = await pageB.text();
    const aDigits = (shopA.phone || "").replace(/\D/g, "");
    record(
      "tenant isolation: shop A slug/number never on shop B page",
      pageB.status === 200 &&
        htmlB.includes(shopB.business.slug) &&
        !htmlB.includes(shopA.business.slug) &&
        !(aDigits && htmlB.includes(aDigits)),
      `A=${shopA.business.slug} B=${shopB.business.slug}`,
    );

    const empty = await createShop({
      suffix: "e",
      phoneSlot: 3,
      withProduct: false,
    });
    shops.push(empty);
    const cookiesE = await mintOwnerCookies(empty.email);
    const pageE = await fetch(`${BASE}/dashboard/share`, {
      headers: { Cookie: cookieHeader(cookiesE), Accept: "text/html" },
    });
    const htmlE = await pageE.text();
    record(
      "no active products: Add a product first",
      pageE.status === 200 &&
        /data-tf-share-no-products/i.test(htmlE) &&
        (/Add a product first|Ajoutez d'abord un produit/i.test(htmlE) ||
          /Go to Products|Aller aux produits/i.test(htmlE)) &&
        !/data-tf-share-link/i.test(htmlE),
      `status=${pageE.status}`,
    );

    const closed = await createShop({
      suffix: "c",
      phoneSlot: 4,
      closedAt: new Date().toISOString(),
    });
    shops.push(closed);
    const cookiesC = await mintOwnerCookies(closed.email);
    const pageC = await fetch(`${BASE}/dashboard/share`, {
      headers: { Cookie: cookieHeader(cookiesC), Accept: "text/html" },
    });
    const htmlC = await pageC.text();
    record(
      "suspended shop: notice and no tools",
      pageC.status === 200 &&
        /data-tf-share-not-live/i.test(htmlC) &&
        !/data-tf-share-link/i.test(htmlC) &&
        !/data-tf-share-qr/i.test(htmlC),
      `status=${pageC.status}`,
    );

    const waCheck = runTsx(`
      import { whatsappDigitsFromPhoneOrLink, waMeOrderUrl } from "../src/lib/storefront/whatsapp-cart.ts";
      const phone = ${JSON.stringify(shopA.phone)};
      const digits = whatsappDigitsFromPhoneOrLink(phone);
      const msg = "Hi, I'd like to order";
      const link = waMeOrderUrl(phone, msg);
      console.log(JSON.stringify({
        digits,
        url: link,
        encoded: link.includes(encodeURIComponent(msg)),
        noPlusInPath: !link.split("?")[0].includes("+"),
      }));
    `);
    const waLine = (waCheck.stdout || "").trim().split("\n").filter(Boolean).pop();
    let w = {};
    try {
      w = JSON.parse(waLine || "{}");
    } catch {
      w = {};
    }
    record(
      "wa.me uses digits only + URL-encoded text",
      Boolean(w.digits) &&
        /^\d+$/.test(w.digits) &&
        String(w.url).startsWith(`https://wa.me/${w.digits}?text=`) &&
        w.encoded === true &&
        w.noPlusInPath === true,
      JSON.stringify(w),
    );

    const noWa = await createShop({
      suffix: "n",
      phoneSlot: 5,
      withWhatsApp: false,
    });
    shops.push(noWa);
    const cookiesN = await mintOwnerCookies(noWa.email);
    const pageN = await fetch(`${BASE}/dashboard/share`, {
      headers: { Cookie: cookieHeader(cookiesN), Accept: "text/html" },
    });
    const htmlN = await pageN.text();
    record(
      "WhatsApp section hidden when no number (no wa.me order link in page)",
      pageN.status === 200 &&
        /data-tf-share-page/i.test(htmlN) &&
        !/wa\.me\/\d+\?text=/i.test(htmlN),
      `status=${pageN.status}`,
    );

    const home = await fetch(`${BASE}/dashboard/orders`, {
      headers: { Cookie: cookieHeader(cookiesA), Accept: "text/html" },
    });
    const homeHtml = await home.text();
    record(
      "quiet Share your shop link on seller home",
      home.status === 200 &&
        /data-tf-share-home/i.test(homeHtml) &&
        /href="\/dashboard\/share"/i.test(homeHtml),
      `status=${home.status}`,
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
