/**
 * Seeds two test tenants and verifies RLS isolation.
 * Run after migration: node scripts/verify-rls.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function loadEnv() {
  const envPath = resolve(root, ".env.local");
  const content = readFileSync(envPath, "utf8");
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

if (!url || !anonKey || !serviceKey) {
  console.error("Missing Supabase env vars in .env.local");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TENANT_A = {
  email: "tenant-a@tradeflow-test.local",
  password: "TestTenantA!123",
  slug: "tenant-a",
  name: "Tenant A",
  product: "Tenant A Product",
};
const TENANT_B = {
  email: "tenant-b@tradeflow-test.local",
  password: "TestTenantB!123",
  slug: "tenant-b",
  name: "Tenant B",
  product: "Tenant B Product",
};

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

async function cleanup() {
  const slugs = [TENANT_A.slug, TENANT_B.slug];
  const { data: businesses } = await admin
    .from("businesses")
    .select("id")
    .in("slug", slugs);
  if (businesses?.length) {
    const ids = businesses.map((b) => b.id);
    await admin.from("products").delete().in("business_id", ids);
    await admin.from("businesses").delete().in("id", ids);
  }
}

async function seedTenant(config, ownerUserId) {
  const { data: business, error: bizError } = await admin
    .from("businesses")
    .insert({
      owner_user_id: ownerUserId,
      slug: config.slug,
      name: config.name,
    })
    .select("id")
    .single();
  if (bizError) throw bizError;

  const { data: product, error: prodError } = await admin
    .from("products")
    .insert({
      business_id: business.id,
      name: config.product,
      price_pence: 999,
    })
    .select("id, name, business_id")
    .single();
  if (prodError) throw prodError;

  return { businessId: business.id, product };
}

function logResult(label, result) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  console.log("Cleaning up prior test data...");
  await cleanup();

  console.log("Creating test users...");
  const userAId = await ensureUser(TENANT_A.email, TENANT_A.password);
  const userBId = await ensureUser(TENANT_B.email, TENANT_B.password);

  console.log("Seeding tenants (service role, bypasses RLS)...");
  const tenantA = await seedTenant(TENANT_A, userAId);
  const tenantB = await seedTenant(TENANT_B, userBId);

  logResult("Seeded Tenant A", tenantA);
  logResult("Seeded Tenant B", tenantB);

  const clientA = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: signInError } = await clientA.auth.signInWithPassword({
    email: TENANT_A.email,
    password: TENANT_A.password,
  });
  if (signInError) throw signInError;

  // Test 1: Tenant A reads own products
  const ownProducts = await clientA
    .from("products")
    .select("id, name, business_id")
    .eq("business_id", tenantA.businessId);
  logResult("Query: Tenant A own products", {
    query:
      "SELECT id, name, business_id FROM products WHERE business_id = :tenant_a_id",
    error: ownProducts.error?.message ?? null,
    rowCount: ownProducts.data?.length ?? 0,
    rows: ownProducts.data,
  });

  // Test 2: Tenant A attempts to read Tenant B products (must return 0 rows)
  const crossTenant = await clientA
    .from("products")
    .select("id, name, business_id")
    .eq("business_id", tenantB.businessId);
  logResult("Query: Tenant A reads Tenant B products (expect 0 rows)", {
    query:
      "SELECT id, name, business_id FROM products WHERE business_id = :tenant_b_id",
    error: crossTenant.error?.message ?? null,
    rowCount: crossTenant.data?.length ?? 0,
    rows: crossTenant.data,
  });

  // Test 3: Tenant A reads all products visible to them
  const allVisible = await clientA.from("products").select("id, name, business_id");
  logResult("Query: Tenant A SELECT * FROM products (RLS filtered)", {
    query: "SELECT id, name, business_id FROM products",
    error: allVisible.error?.message ?? null,
    rowCount: allVisible.data?.length ?? 0,
    rows: allVisible.data,
  });

  // Test 4: Tenant A INSERT own product (write)
  const insertOwn = await clientA
    .from("products")
    .insert({
      business_id: tenantA.businessId,
      name: "Tenant A New Product",
      price_pence: 1500,
    })
    .select("id, name")
    .single();
  logResult("Query: Tenant A INSERT own product", {
    query:
      "INSERT INTO products (business_id, name, price_pence) VALUES (:tenant_a_id, ...)",
    error: insertOwn.error?.message ?? null,
    row: insertOwn.data,
  });

  // Test 5: Tenant A UPDATE own product
  const updateOwn = await clientA
    .from("products")
    .update({ price_pence: 1600 })
    .eq("id", tenantA.product.id)
    .select("id, price_pence")
    .single();
  logResult("Query: Tenant A UPDATE own product", {
    query: "UPDATE products SET price_pence = 1600 WHERE id = :own_product_id",
    error: updateOwn.error?.message ?? null,
    row: updateOwn.data,
  });

  // Test 6: Tenant A INSERT into Tenant B (must fail or affect 0 rows)
  const insertCross = await clientA.from("products").insert({
    business_id: tenantB.businessId,
    name: "Malicious Product",
    price_pence: 100,
  });
  logResult("Query: Tenant A INSERT into Tenant B (expect denied)", {
    query:
      "INSERT INTO products (business_id, name, price_pence) VALUES (:tenant_b_id, ...)",
    error: insertCross.error?.message ?? null,
    data: insertCross.data,
  });

  const passed =
    (ownProducts.data?.length ?? 0) >= 1 &&
    (crossTenant.data?.length ?? 0) === 0 &&
    (allVisible.data?.length ?? 0) >= 1 &&
    !insertOwn.error &&
    !updateOwn.error &&
    !!insertCross.error;

  console.log("\n========================================");
  console.log(passed ? "RLS VERIFICATION: PASSED" : "RLS VERIFICATION: FAILED");
  console.log("========================================");

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
