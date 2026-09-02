/**
 * Verifies per-product image galleries:
 *   1. Add 4 images, reorder, photo_url follows sort_order 0
 *   2. Live storefront card carousels those 4 images
 *   3. A 1-image product still uses the static photo path (no carousel)
 *   4. A 0-image product still uses the ring-motif fallback
 *   5. Deleting down to 1 image drops the carousel
 *   6. Storefront OG tags still use the shop cover (banner/logo), not gallery
 *   7. CSV import still uses the single photo_url column (no gallery rows)
 *   8. Cross-tenant writes to another shop's gallery are denied
 *
 * Requires the Next.js dev server. Run:
 *   node scripts/verify-product-images.mjs
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

const stamp = Date.now();
const QUAD = `Gallery Quad ${stamp}`;
const SINGLE = `Gallery Single ${stamp}`;
const EMPTY = `Gallery Empty ${stamp}`;
const CSV_NAME = `Gallery CSV ${stamp}`;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function mintSeller(email, password) {
  const client = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  if (password) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }
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

async function mintCookies(email) {
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

function applySetCookie(cookies, response) {
  const headers =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const headerLine of headers) {
    const pair = headerLine.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const i = cookies.findIndex((c) => c.name === name);
    if (i >= 0) cookies[i] = { name, value };
    else cookies.push({ name, value });
  }
}

async function createProduct(seller, businessId, name, photoUrl) {
  const { data, error } = await seller
    .from("products")
    .insert({
      business_id: businessId,
      name,
      description: `${name} test product`,
      price_pence: 1500,
      photo_url: photoUrl,
      active: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const { error: variantError } = await seller.from("product_variants").insert({
    product_id: data.id,
    business_id: businessId,
    label: "Standard",
    stock_quantity: 8,
    reserved_quantity: 0,
    low_stock_threshold: 5,
    track_inventory: true,
    weight_grams: 200,
  });
  if (variantError) throw new Error(variantError.message);
  return data.id;
}

async function replaceGallery(seller, productId, businessId, urls) {
  const { error: delError } = await seller
    .from("product_images")
    .delete()
    .eq("product_id", productId);
  if (delError) throw new Error(delError.message);
  if (!urls.length) return;
  const { error: insError } = await seller.from("product_images").insert(
    urls.map((image_url, sort_order) => ({
      product_id: productId,
      business_id: businessId,
      image_url,
      sort_order,
    })),
  );
  if (insError) throw new Error(insError.message);
}

async function uploadPng(seller, businessId, stampSuffix, png) {
  const path = `${businessId}/product-gallery-${stamp}-${stampSuffix}.png`;
  const file = new File([png], `${stampSuffix}.png`, { type: "image/png" });
  validateImageFile(file);
  const { error } = await seller.storage.from("product-images").upload(path, png, {
    contentType: "image/png",
    upsert: false,
    cacheControl: "3600",
  });
  if (error) throw new Error(error.message);
  const { data } = seller.storage.from("product-images").getPublicUrl(path);
  return data.publicUrl;
}

async function loadProduct(id) {
  const { data, error } = await admin
    .from("products")
    .select("id, name, photo_url, product_images(image_url, sort_order)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const images = (data?.product_images ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  return { ...data, images };
}

async function fetchStorefront(slug) {
  const response = await fetch(`${BASE}/s/${slug}`, {
    headers: { Accept: "text/html", "User-Agent": "WhatsApp/2.24.0" },
    cache: "no-store",
  });
  const html = await response.text();
  return { status: response.status, html };
}

async function deleteProducts(ids) {
  if (!ids.length) return;
  await admin.from("product_images").delete().in("product_id", ids);
  await admin.from("product_variants").delete().in("product_id", ids);
  await admin.from("products").delete().in("id", ids);
}

async function main() {
  const { data: ek, error: ekError } = await admin
    .from("businesses")
    .select("id, slug, name, logo_url, banner_url")
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

  console.log(`BASE ${BASE}`);
  console.log(`EK ${ek.name} slug=${ek.slug} id=${ek.id}\n`);

  const seller = await mintSeller(EK_EMAIL);
  const createdIds = [];

  try {
    const colors = [
      [224, 122, 95],
      [18, 40, 64],
      [245, 197, 24],
      [46, 125, 90],
    ];
    const quadUrls = [];
    for (let i = 0; i < 4; i += 1) {
      const [r, g, b] = colors[i];
      quadUrls.push(await uploadPng(seller, ek.id, `q${i}`, rgbPng(320, 240, r, g, b)));
    }
    const singleUrl = await uploadPng(
      seller,
      ek.id,
      "single",
      rgbPng(320, 240, 90, 90, 180),
    );
    const csvPhotoUrl = await uploadPng(
      seller,
      ek.id,
      "csv",
      rgbPng(320, 240, 20, 140, 160),
    );

    const quadId = await createProduct(seller, ek.id, QUAD, null);
    createdIds.push(quadId);
    await replaceGallery(seller, quadId, ek.id, quadUrls);

    const singleId = await createProduct(seller, ek.id, SINGLE, singleUrl);
    createdIds.push(singleId);
    await replaceGallery(seller, singleId, ek.id, [singleUrl]);

    const emptyId = await createProduct(seller, ek.id, EMPTY, null);
    createdIds.push(emptyId);

    const cookies = await mintCookies(EK_EMAIL);
    const switchRes = await fetch(`${BASE}/api/dashboard/active-business`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader(cookies),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ businessId: ek.id }),
      redirect: "manual",
      cache: "no-store",
    });
    applySetCookie(cookies, switchRes);

    const formPage = await fetch(`${BASE}/dashboard/products/${quadId}`, {
      headers: { Cookie: cookieHeader(cookies) },
      redirect: "manual",
      cache: "no-store",
    });
    const formHtml = await formPage.text();
    record(
      "Dashboard product form is a multi-image uploader (not a photo URL field)",
      formPage.status === 200 &&
        /Photos/i.test(formHtml) &&
        formHtml.includes('type="file"') &&
        /multiple/i.test(formHtml) &&
        !/Photo URL/i.test(formHtml),
      `status=${formPage.status} photos=${/Photos/i.test(formHtml)} file=${formHtml.includes('type="file"')} multiple=${/multiple/i.test(formHtml)}`,
    );

    const stored = await loadProduct(quadId);
    const storedUrls = stored.images.map((image) => image.image_url);
    record(
      "1a. Four images stored in order with photo_url = sort_order 0",
      storedUrls.length === 4 &&
        storedUrls.every((u, i) => u === quadUrls[i]) &&
        stored.photo_url === quadUrls[0],
      `count=${storedUrls.length} cover=${stored.photo_url === quadUrls[0]}`,
    );

    const reordered = [quadUrls[2], quadUrls[0], quadUrls[3], quadUrls[1]];
    await replaceGallery(seller, quadId, ek.id, reordered);
    const afterReorder = await loadProduct(quadId);
    const afterUrls = afterReorder.images.map((image) => image.image_url);
    record(
      "1b. Reordering updates sort_order and re-syncs photo_url to the new first image",
      afterUrls.length === 4 &&
        afterUrls.every((u, i) => u === reordered[i]) &&
        afterReorder.photo_url === reordered[0] &&
        afterReorder.photo_url !== quadUrls[0],
      `cover=${afterReorder.photo_url === reordered[0]}`,
    );

    const storefront = await fetchStorefront(ek.slug);
    const galleryOnPage =
      storefront.html.includes('data-product-gallery') &&
      storefront.html.includes('data-gallery-count="4"');
    const allFourOnPage = reordered.every((u) => storefront.html.includes(u));
    record(
      "2. Storefront card shows a 4-image thumbnail/carousel in the new order",
      storefront.status === 200 &&
        storefront.html.includes(QUAD) &&
        galleryOnPage &&
        allFourOnPage,
      `status=${storefront.status} gallery=${galleryOnPage} allFour=${allFourOnPage}`,
    );

    const singleOnPage = storefront.html.includes(SINGLE) && storefront.html.includes(singleUrl);
    const noSingleCarousel = !storefront.html.includes('data-gallery-count="1"');
    record(
      "3. One-image product still uses the static photo path (no 1-item carousel)",
      storefront.status === 200 && singleOnPage && noSingleCarousel,
      `name=${storefront.html.includes(SINGLE)} photo=${storefront.html.includes(singleUrl)} noCount1=${noSingleCarousel}`,
    );

    const emptyProduct = await loadProduct(emptyId);
    const emptyOnPage = storefront.html.includes(EMPTY);
    const emptyHasRing =
      storefront.html.includes("tf-nodes-ring") ||
      storefront.html.includes("tf-product-slot");
    record(
      "4. Zero-image product keeps the ring-motif fallback (no gallery, photo_url null)",
      emptyOnPage &&
        emptyProduct.photo_url == null &&
        emptyProduct.images.length === 0 &&
        emptyHasRing &&
        !storefront.html.includes('data-gallery-count="0"'),
      `name=${emptyOnPage} photo_url=${emptyProduct.photo_url} images=${emptyProduct.images.length}`,
    );

    const ogImage = metaContent(storefront.html, "property", "og:image");
    const expectedOg =
      (ek.banner_url && ek.banner_url.trim()) ||
      (ek.logo_url && ek.logo_url.trim()) ||
      null;
    const ogUsesCover =
      Boolean(ogImage) &&
      (expectedOg ? ogImage === expectedOg : /\/og\/default/.test(ogImage));
    const ogNotGallery = reordered.every((u) => ogImage !== u);
    record(
      "6. OG tags still use the shop cover image, not the product gallery",
      storefront.status === 200 && ogUsesCover && ogNotGallery && afterReorder.photo_url === reordered[0],
      JSON.stringify({ ogImage, expectedOg, coverSynced: afterReorder.photo_url === reordered[0] }),
    );

    await replaceGallery(seller, quadId, ek.id, [reordered[0]]);
    const afterDelete = await loadProduct(quadId);
    const afterOne = await fetchStorefront(ek.slug);
    record(
      "5. Deleting down to 1 image drops the carousel and keeps the static photo",
      afterDelete.images.length === 1 &&
        afterDelete.photo_url === reordered[0] &&
        afterOne.html.includes(reordered[0]) &&
        !afterOne.html.includes('data-gallery-count="4"') &&
        !afterOne.html.includes('data-gallery-count="1"') &&
        afterOne.html.includes(QUAD),
      `images=${afterDelete.images.length} cover=${afterDelete.photo_url === reordered[0]} count4=${afterOne.html.includes('data-gallery-count="4"')}`,
    );

    const csvSrc = readFileSync(resolve(root, "src/lib/products/csv-import.ts"), "utf8");
    const columnsMatch = /export const CSV_COLUMNS = \[([\s\S]*?)\] as const/.exec(csvSrc);
    const columns = columnsMatch
      ? [...columnsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : [];
    const csvColumnsUnchanged =
      columns.includes("photo_url") &&
      !columns.some((col) => /gallery|image_urls|product_images/.test(col));

    const csvBody = [
      "product_name,description,price_gbp,photo_url,active,variant_label,stock_quantity,low_stock_threshold,weight_grams",
      `${CSV_NAME},"CSV gallery check.",11.00,${csvPhotoUrl},yes,,4,5,200`,
    ].join("\n");
    const importRes = await fetch(`${BASE}/api/dashboard/products/import`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader(cookies),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ csv: csvBody, confirm: true }),
      cache: "no-store",
    });
    const importJson = await importRes.json().catch(() => ({}));
    const csvId = importJson.productIds?.[0];
    if (csvId) createdIds.push(csvId);
    const csvRow = csvId ? await loadProduct(csvId) : null;
    const csvStorefront = await fetchStorefront(ek.slug);
    record(
      "7. CSV import still uses photo_url only (no gallery rows, storefront single-image path)",
      csvColumnsUnchanged &&
        importRes.status === 200 &&
        importJson.ok === true &&
        Boolean(csvRow) &&
        csvRow.photo_url === csvPhotoUrl &&
        csvRow.images.length === 0 &&
        csvStorefront.html.includes(CSV_NAME) &&
        csvStorefront.html.includes(csvPhotoUrl) &&
        !csvStorefront.html.includes('data-gallery-count="1"'),
      `columns=${columns.join(",")} status=${importRes.status} images=${csvRow?.images.length} photo=${csvRow?.photo_url === csvPhotoUrl}`,
    );

    const tenantClient = await mintSeller(TENANT_A.email, TENANT_A.password);
    const { error: crossInsert } = await tenantClient.from("product_images").insert({
      product_id: singleId,
      business_id: ek.id,
      image_url: csvPhotoUrl,
      sort_order: 1,
    });
    const { error: crossInsertOwnBiz } = await tenantClient.from("product_images").insert({
      product_id: singleId,
      business_id: tenantA.id,
      image_url: csvPhotoUrl,
      sort_order: 1,
    });
    const { error: crossDelete } = await tenantClient
      .from("product_images")
      .delete()
      .eq("product_id", singleId);
    const singleAfterCross = await loadProduct(singleId);
    record(
      "8. A seller cannot add/reorder/delete images on another shop's products",
      Boolean(crossInsert) &&
        Boolean(crossInsertOwnBiz) &&
        singleAfterCross.images.length === 1 &&
        singleAfterCross.images[0].image_url === singleUrl,
      `insertOtherBiz=${crossInsert?.message} insertOwnBiz=${crossInsertOwnBiz?.message} delete=${crossDelete?.message ?? "none"} remaining=${singleAfterCross.images.length}`,
    );
  } finally {
    await deleteProducts(createdIds);
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
