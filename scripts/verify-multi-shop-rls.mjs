/**
 * Confirms the schema + RLS already allow one auth user to own multiple
 * businesses rows. Creates throwaway test users only — does not touch
 * real seller data.
 *
 *   node scripts/verify-multi-shop-rls.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error("Missing Supabase env vars in .env.local");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const OWNER = {
  email: `multi-shop-owner-${stamp}@tradeflow-test.local`,
  password: "MultiShopOwner!123",
};
const OTHER = {
  email: `multi-shop-other-${stamp}@tradeflow-test.local`,
  password: "MultiShopOther!123",
};
const SLUG_A = `multi-shop-a-${stamp}`;
const SLUG_B = `multi-shop-b-${stamp}`;
const SLUG_SERVICE = `multi-shop-svc-${stamp}`;

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function ensureUser(email, password) {
  const { data: listed } = await admin.auth.admin.listUsers();
  const existing = listed?.users?.find((u) => u.email === email);
  if (existing) {
    await admin.auth.admin.updateUserById(existing.id, { password });
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

async function signIn(email, password) {
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function cleanup(ownerUserId, otherUserId) {
  const slugs = [SLUG_A, SLUG_B, SLUG_SERVICE];
  const { data: businesses } = await admin
    .from("businesses")
    .select("id")
    .in("slug", slugs);
  if (businesses?.length) {
    const ids = businesses.map((b) => b.id);
    await admin.from("products").delete().in("business_id", ids);
    await admin.from("businesses").delete().in("id", ids);
  }
  if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId);
  if (otherUserId) await admin.auth.admin.deleteUser(otherUserId);
}

async function main() {
  let ownerUserId = null;
  let otherUserId = null;

  try {
    ownerUserId = await ensureUser(OWNER.email, OWNER.password);
    otherUserId = await ensureUser(OTHER.email, OTHER.password);

    // 1. Authenticated owner inserts first business (RLS insert policy).
    const ownerClient = await signIn(OWNER.email, OWNER.password);
    const firstInsert = await ownerClient
      .from("businesses")
      .insert({
        owner_user_id: ownerUserId,
        slug: SLUG_A,
        name: "Multi Shop A",
      })
      .select("id, owner_user_id, slug")
      .single();
    record(
      "Authenticated INSERT of first business (RLS)",
      !firstInsert.error && firstInsert.data?.owner_user_id === ownerUserId,
      firstInsert.error?.message ?? `id=${firstInsert.data?.id}`,
    );
    if (firstInsert.error) throw firstInsert.error;

    // 2. Same authenticated owner inserts a SECOND business — the schema
    //    constraint question. If this fails with a unique-violation, STOP.
    const secondInsert = await ownerClient
      .from("businesses")
      .insert({
        owner_user_id: ownerUserId,
        slug: SLUG_B,
        name: "Multi Shop B",
      })
      .select("id, owner_user_id, slug")
      .single();
    const uniqueViolation =
      secondInsert.error?.code === "23505" ||
      /duplicate key|unique/i.test(secondInsert.error?.message ?? "");
    record(
      "Authenticated INSERT of second business for the same owner_user_id",
      !secondInsert.error && secondInsert.data?.owner_user_id === ownerUserId,
      secondInsert.error
        ? `code=${secondInsert.error.code} message=${secondInsert.error.message} uniqueViolation=${uniqueViolation}`
        : `id=${secondInsert.data?.id}`,
    );

    // 3. Service-role insert of a third row (bypasses RLS, still hits schema).
    const serviceInsert = await admin
      .from("businesses")
      .insert({
        owner_user_id: ownerUserId,
        slug: SLUG_SERVICE,
        name: "Multi Shop Service",
      })
      .select("id, owner_user_id")
      .single();
    record(
      "Service-role INSERT of a third business for the same owner_user_id",
      !serviceInsert.error && serviceInsert.data?.owner_user_id === ownerUserId,
      serviceInsert.error?.message ?? `id=${serviceInsert.data?.id}`,
    );

    // 4. Owner SELECT — RLS must return every owned row, not just one.
    const owned = await ownerClient
      .from("businesses")
      .select("id, slug, name")
      .eq("owner_user_id", ownerUserId)
      .is("deleted_at", null);
    const ownedSlugs = (owned.data ?? []).map((b) => b.slug).sort();
    record(
      "Owner SELECT sees both (all) owned businesses via RLS",
      !owned.error && ownedSlugs.includes(SLUG_A) && ownedSlugs.includes(SLUG_B),
      owned.error?.message ?? `slugs=${ownedSlugs.join(",")}`,
    );

    // 5. Seed a product on shop A so we can test child-table RLS.
    const productA = await ownerClient
      .from("products")
      .insert({
        business_id: firstInsert.data.id,
        name: "Shop A Product",
        price_pence: 500,
      })
      .select("id, business_id")
      .single();
    const productB = secondInsert.data
      ? await ownerClient
          .from("products")
          .insert({
            business_id: secondInsert.data.id,
            name: "Shop B Product",
            price_pence: 700,
          })
          .select("id, business_id")
          .single()
      : { data: null, error: { message: "skipped — second business insert failed" } };
    record(
      "Owner can INSERT products into each of their businesses",
      !productA.error && !productB.error,
      productA.error?.message ?? productB.error?.message ?? "ok",
    );

    const allProducts = await ownerClient
      .from("products")
      .select("id, name, business_id");
    record(
      "Owner SELECT products returns rows from both owned businesses",
      !allProducts.error && (allProducts.data?.length ?? 0) >= 2,
      allProducts.error?.message ?? `count=${allProducts.data?.length ?? 0}`,
    );

    // 6. Unrelated user must see none of the owner's businesses or products.
    const otherClient = await signIn(OTHER.email, OTHER.password);
    const otherBusinesses = await otherClient
      .from("businesses")
      .select("id, slug")
      .in("slug", [SLUG_A, SLUG_B, SLUG_SERVICE]);
    record(
      "Unrelated user SELECT of owner's businesses returns 0 rows",
      !otherBusinesses.error && (otherBusinesses.data?.length ?? 0) === 0,
      otherBusinesses.error?.message ?? `count=${otherBusinesses.data?.length ?? 0}`,
    );

    const otherProducts = await otherClient.from("products").select("id, name, business_id");
    const leaked = (otherProducts.data ?? []).filter(
      (row) =>
        row.business_id === firstInsert.data.id ||
        row.business_id === secondInsert.data?.id,
    );
    record(
      "Unrelated user cannot see products belonging to either owned shop",
      !otherProducts.error && leaked.length === 0,
      otherProducts.error?.message ?? `leaked=${leaked.length}`,
    );

    const otherInsertCross = await otherClient.from("products").insert({
      business_id: firstInsert.data.id,
      name: "Malicious Product",
      price_pence: 1,
    });
    record(
      "Unrelated user INSERT into owner's business is denied",
      !!otherInsertCross.error,
      otherInsertCross.error?.message ?? "insert unexpectedly succeeded",
    );
  } finally {
    await cleanup(ownerUserId, otherUserId);
  }

  const passed = results.every((r) => r.passed);
  console.log("\n========================================");
  console.log(
    passed
      ? "MULTI-SHOP RLS: PASSED — no unique constraint; RLS already supports one owner, many shops"
      : "MULTI-SHOP RLS: FAILED",
  );
  console.log("========================================");
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
