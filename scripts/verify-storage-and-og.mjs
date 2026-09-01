/**
 * Verifies F4 storage uploads + Open Graph tags:
 *   1. EK seller uploads a product photo; public storefront serves it
 *   2. Logo + banner upload; storefront hero/header show both
 *   3. Non-image / oversized files fail clearly without mutating the row
 *   4. /s/[slug] HTML head has real OG + Twitter tags
 *   7. Cross-tenant storage paths are denied
 *
 * Tests 5–6 (real WhatsApp preview + in-app browser) cannot run here.
 *
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-storage-and-og.mjs
 */
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const EK_EMAIL = "sgkiket@gmail.com";
const TENANT_A = {
  email: "tenant-a@tradeflow-test.local",
  password: "TestTenantA!123",
  slug: "tenant-a",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

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

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function rgbPng(width, height, r, g, b) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function validateImageFile(file) {
  const mime = (file.type || "").toLowerCase();
  const looksLikeImage =
    ALLOWED_MIME.has(mime) ||
    (!mime && /\.(jpe?g|png|webp|gif)$/i.test(file.name));
  if (!looksLikeImage) {
    throw new Error("Please choose a JPEG, PNG, WebP, or GIF image.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("That image is too large. Maximum size is 5 MB.");
  }
  if (file.size <= 0) {
    throw new Error("That file is empty. Please choose another image.");
  }
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function metaContent(html, attr, key) {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const reFlip = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${key}["'][^>]*>`,
    "i",
  );
  const raw = re.exec(html)?.[1] ?? reFlip.exec(html)?.[1] ?? null;
  return raw ? decodeEntities(raw) : null;
}

const env = loadEnv();
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

async function mintSeller(email) {
  const client = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const { error: otpError } = await client.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError) throw otpError;
  return client;
}

async function mintEkCookies() {
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
    email: EK_EMAIL,
  });
  if (linkError) throw linkError;
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError) throw otpError;
  return cookies;
}

async function uploadPng(client, bucket, path, png) {
  return client.storage.from(bucket).upload(path, png, {
    contentType: "image/png",
    upsert: false,
    cacheControl: "3600",
  });
}

async function main() {
  const { data: ek, error: ekError } = await admin
    .from("businesses")
    .select("id, slug, name, logo_url, banner_url, bio")
    .eq("name", "EK-Pousser_D")
    .is("deleted_at", null)
    .maybeSingle();
  if (ekError) throw new Error(ekError.message);
  if (!ek) throw new Error("EK-Pousser_D not found");

  const { data: tenantA, error: tenantError } = await admin
    .from("businesses")
    .select("id, slug, name")
    .eq("slug", TENANT_A.slug)
    .is("deleted_at", null)
    .maybeSingle();
  if (tenantError) throw new Error(tenantError.message);
  if (!tenantA) throw new Error("tenant-a not found");

  const { data: mug, error: mugError } = await admin
    .from("products")
    .select("id, name, photo_url")
    .eq("business_id", ek.id)
    .eq("name", "Classic Blue Mug")
    .is("deleted_at", null)
    .maybeSingle();
  if (mugError) throw new Error(mugError.message);
  if (!mug) throw new Error("Classic Blue Mug not found");

  const { data: trackingOrder } = await admin
    .from("orders")
    .select("order_ref")
    .eq("business_id", ek.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log(`BASE ${BASE}`);
  console.log(`EK ${ek.name} slug=${ek.slug} id=${ek.id}`);
  console.log(`Mug ${mug.id} previous photo=${mug.photo_url ?? "none"}`);
  console.log(`Tenant A ${tenantA.id}\n`);

  const seller = await mintSeller(EK_EMAIL);
  const stamp = Date.now().toString(16);
  const productPath = `${ek.id}/product-${stamp}.png`;
  const logoPath = `${ek.id}/logo-${stamp}.png`;
  const bannerPath = `${ek.id}/banner-${stamp}.png`;
  const productPng = rgbPng(480, 360, 224, 122, 95);
  const logoPng = rgbPng(256, 256, 18, 40, 64);
  const bannerPng = rgbPng(1200, 400, 245, 197, 24);

  const productUp = await uploadPng(seller, "product-images", productPath, productPng);
  record(
    "Seller can upload into own product-images path",
    !productUp.error,
    productUp.error?.message ?? productPath,
  );
  const { data: productPublic } = seller.storage
    .from("product-images")
    .getPublicUrl(productPath);
  const productUrl = productPublic.publicUrl;
  const { error: mugSaveError } = await seller
    .from("products")
    .update({ photo_url: productUrl })
    .eq("id", mug.id);
  record(
    "Seller can save the public URL onto their product",
    !mugSaveError && Boolean(productUrl),
    mugSaveError?.message ?? productUrl,
  );

  const logoUp = await uploadPng(seller, "business-branding", logoPath, logoPng);
  const bannerUp = await uploadPng(seller, "business-branding", bannerPath, bannerPng);
  const { data: logoPublic } = seller.storage
    .from("business-branding")
    .getPublicUrl(logoPath);
  const { data: bannerPublic } = seller.storage
    .from("business-branding")
    .getPublicUrl(bannerPath);
  const logoUrl = logoPublic.publicUrl;
  const bannerUrl = bannerPublic.publicUrl;
  const { error: brandSaveError } = await seller
    .from("businesses")
    .update({ logo_url: logoUrl, banner_url: bannerUrl })
    .eq("id", ek.id);
  record(
    "Seller can upload logo + banner into own business-branding path",
    !logoUp.error && !bannerUp.error && !brandSaveError,
    logoUp.error?.message ||
      bannerUp.error?.message ||
      brandSaveError?.message ||
      `${logoUrl} | ${bannerUrl}`,
  );

  const storefront = await fetch(`${BASE}/s/${ek.slug}`, {
    headers: { Accept: "text/html", "User-Agent": "WhatsApp/2.24.0" },
    cache: "no-store",
  });
  const storefrontHtml = await storefront.text();
  const storefrontPass =
    storefront.status === 200 &&
    storefrontHtml.includes(productUrl) &&
    storefrontHtml.includes(logoUrl) &&
    storefrontHtml.includes(bannerUrl);
  record(
    "1. Product photo, logo, and banner appear on the live storefront",
    storefrontPass,
    `status=${storefront.status} photo=${storefrontHtml.includes(productUrl)} logo=${storefrontHtml.includes(logoUrl)} banner=${storefrontHtml.includes(bannerUrl)}`,
  );

  const txtFile = new File([Buffer.from("not-an-image")], "notes.txt", {
    type: "text/plain",
  });
  const hugeFile = new File([Buffer.alloc(MAX_IMAGE_BYTES + 64)], "huge.jpg", {
    type: "image/jpeg",
  });
  let txtMessage = null;
  let hugeMessage = null;
  try {
    validateImageFile(txtFile);
  } catch (caught) {
    txtMessage = caught instanceof Error ? caught.message : String(caught);
  }
  try {
    validateImageFile(hugeFile);
  } catch (caught) {
    hugeMessage = caught instanceof Error ? caught.message : String(caught);
  }

  const badTxt = await seller.storage
    .from("product-images")
    .upload(`${ek.id}/bad-${stamp}.txt`, Buffer.from("not-an-image"), {
      contentType: "text/plain",
      upsert: false,
    });
  const badHuge = await seller.storage
    .from("product-images")
    .upload(`${ek.id}/huge-${stamp}.jpg`, Buffer.alloc(MAX_IMAGE_BYTES + 64), {
      contentType: "image/jpeg",
      upsert: false,
    });
  const { data: mugAfter } = await admin
    .from("products")
    .select("photo_url")
    .eq("id", mug.id)
    .maybeSingle();
  const { data: bizAfter } = await admin
    .from("businesses")
    .select("logo_url, banner_url")
    .eq("id", ek.id)
    .maybeSingle();
  record(
    "3. Non-image and oversized files fail clearly and do not change saved URLs",
    txtMessage?.includes("JPEG, PNG, WebP, or GIF") &&
      hugeMessage?.includes("too large") &&
      Boolean(badTxt.error) &&
      Boolean(badHuge.error) &&
      mugAfter?.photo_url === productUrl &&
      bizAfter?.logo_url === logoUrl &&
      bizAfter?.banner_url === bannerUrl,
    `uiTxt=${txtMessage} uiHuge=${hugeMessage} storageTxt=${badTxt.error?.message} storageHuge=${badHuge.error?.message}`,
  );

  const ogTitle = metaContent(storefrontHtml, "property", "og:title");
  const ogDescription = metaContent(storefrontHtml, "property", "og:description");
  const ogImage = metaContent(storefrontHtml, "property", "og:image");
  const ogUrl = metaContent(storefrontHtml, "property", "og:url");
  const twitterCard = metaContent(storefrontHtml, "name", "twitter:card");
  const expectedOgUrl = `https://tradeflow-tau-blush.vercel.app/s/${ek.slug}`;
  const expectedDesc =
    (ek.bio ?? "").trim() || `Shop ${ek.name} on TradeFlow`;
  const ogPass =
    ogTitle === ek.name &&
    ogDescription === expectedDesc &&
    ogImage === bannerUrl &&
    ogUrl === expectedOgUrl &&
    twitterCard === "summary_large_image";
  record(
    "4. /s/[slug] HTML head has OG + Twitter tags with real values",
    ogPass,
    JSON.stringify({ ogTitle, ogDescription, ogImage, ogUrl, twitterCard }),
  );

  const defaultOg = await fetch(`${BASE}/og/default`, { cache: "no-store" });
  const defaultType = defaultOg.headers.get("content-type") ?? "";
  const defaultBytes = Buffer.from(await defaultOg.arrayBuffer());
  record(
    "Default OG image route returns a PNG",
    defaultOg.status === 200 &&
      defaultType.includes("image/png") &&
      defaultBytes.length > 1000,
    `status=${defaultOg.status} type=${defaultType} bytes=${defaultBytes.length}`,
  );

  if (trackingOrder?.order_ref) {
    const tracking = await fetch(
      `${BASE}/t/${encodeURIComponent(trackingOrder.order_ref)}`,
      {
        headers: { Accept: "text/html", "User-Agent": "WhatsApp/2.24.0" },
        cache: "no-store",
      },
    );
    const trackingHtml = await tracking.text();
    const tTitle = metaContent(trackingHtml, "property", "og:title");
    const tDesc = metaContent(trackingHtml, "property", "og:description");
    const tImage = metaContent(trackingHtml, "property", "og:image");
    record(
      "Tracking page OG uses the order ref, generic copy, and no status/PII",
      tracking.status === 200 &&
        tTitle === trackingOrder.order_ref &&
        tDesc === "Track your order" &&
        tImage === bannerUrl &&
        !/status:/i.test(tDesc ?? ""),
      JSON.stringify({ tTitle, tDesc, tImage, status: tracking.status }),
    );
  } else {
    record("Tracking page OG uses the order ref, generic copy, and no status/PII", false, "no EK order to fetch");
  }

  const cookies = await mintEkCookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const [settingsPage, productPage] = await Promise.all([
    fetch(`${BASE}/dashboard/settings`, {
      headers: { Cookie: cookieHeader },
      redirect: "manual",
      cache: "no-store",
    }),
    fetch(`${BASE}/dashboard/products/${mug.id}`, {
      headers: { Cookie: cookieHeader },
      redirect: "manual",
      cache: "no-store",
    }),
  ]);
  const settingsHtml = await settingsPage.text();
  const productHtml = await productPage.text();
  record(
    "Dashboard settings exposes logo and banner file inputs",
    settingsPage.status === 200 &&
      /Logo/i.test(settingsHtml) &&
      /Banner/i.test(settingsHtml) &&
      settingsHtml.includes('type="file"'),
    `status=${settingsPage.status}`,
  );
  record(
    "Dashboard product form uses a file upload, not a photo URL text field",
    productPage.status === 200 &&
      productHtml.includes('type="file"') &&
      !/Photo URL/i.test(productHtml),
    `status=${productPage.status}`,
  );

  const crossEk = await seller.storage
    .from("product-images")
    .upload(`${tenantA.id}/cross-${stamp}.png`, productPng, {
      contentType: "image/png",
      upsert: false,
    });
  const tenantClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: tenantSignIn } = await tenantClient.auth.signInWithPassword({
    email: TENANT_A.email,
    password: TENANT_A.password,
  });
  if (tenantSignIn) throw tenantSignIn;
  const crossA = await tenantClient.storage
    .from("product-images")
    .upload(`${ek.id}/cross-${stamp}.png`, productPng, {
      contentType: "image/png",
      upsert: false,
    });
  const anonClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const crossAnon = await anonClient.storage
    .from("product-images")
    .upload(`${ek.id}/anon-${stamp}.png`, productPng, {
      contentType: "image/png",
      upsert: false,
    });
  record(
    "7. Cross-tenant and anonymous writes to another business path are denied",
    Boolean(crossEk.error) && Boolean(crossA.error) && Boolean(crossAnon.error),
    `ekIntoA=${crossEk.error?.message} aIntoEk=${crossA.error?.message} anon=${crossAnon.error?.message}`,
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
