/**
 * Seeds a small active catalog for EK-Pousser_D so order_parse has real
 * products/variants to match against. Idempotent: deletes prior seed rows
 * tagged in notes/description before re-inserting.
 *
 * Run: node scripts/seed-ek-pousser-catalog.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUSINESS_NAME = "EK-Pousser_D";
const SEED_TAG = "[order_parse_seed]";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: business, error } = await admin
    .from("businesses")
    .select("id, name")
    .eq("name", BUSINESS_NAME)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!business) throw new Error(`Business "${BUSINESS_NAME}" not found`);

  const catalog = [
    {
      name: "Classic Blue Mug",
      description: "Ceramic mug, 350ml. Dishwasher-safe glaze.",
      price_pence: 1200,
      variants: [{ label: "Standard", stock_quantity: 25 }],
    },
    {
      name: "Weekend Sneakers",
      description: "Casual sneakers. Order by UK size.",
      price_pence: 4500,
      variants: [
        { label: "Size 9", stock_quantity: 4 },
        { label: "Size 10", stock_quantity: 6 },
        { label: "Size 11", stock_quantity: 3 },
      ],
    },
    {
      name: "Linen Tote Bag",
      description: "Reusable linen tote for daily errands.",
      price_pence: 1800,
      variants: [
        { label: "Natural", stock_quantity: 12 },
        { label: "Navy", stock_quantity: 8 },
      ],
    },
    {
      name: "Honey Soap Bar",
      description: "Hand-poured honey soap, 100g bar.",
      price_pence: 600,
      variants: [{ label: "100g", stock_quantity: 40 }],
    },
  ];

  // Soft-delete prior seed products (and their variants) for a clean re-seed.
  const { data: tagged } = await admin
    .from("products")
    .select("id")
    .eq("business_id", business.id)
    .ilike("description", `%${SEED_TAG}%`);
  const { data: named } = await admin
    .from("products")
    .select("id")
    .eq("business_id", business.id)
    .in(
      "name",
      catalog.map((item) => item.name),
    )
    .is("deleted_at", null);
  const priorIds = [
    ...new Set([...(tagged ?? []), ...(named ?? [])].map((p) => p.id)),
  ];
  if (priorIds.length) {
    await admin
      .from("product_variants")
      .update({ deleted_at: new Date().toISOString() })
      .in("product_id", priorIds);
    await admin
      .from("products")
      .update({ deleted_at: new Date().toISOString(), active: false })
      .in("id", priorIds);
  }

  const summary = [];

  for (const item of catalog) {
    const { data: product, error: productError } = await admin
      .from("products")
      .insert({
        business_id: business.id,
        name: item.name,
        description: item.description,
        price_pence: item.price_pence,
        active: true,
      })
      .select("id, name")
      .single();
    if (productError) throw new Error(productError.message);

    const variantRows = item.variants.map((variant) => ({
      product_id: product.id,
      business_id: business.id,
      label: variant.label,
      stock_quantity: variant.stock_quantity,
      track_inventory: true,
    }));

    const { data: variants, error: variantError } = await admin
      .from("product_variants")
      .insert(variantRows)
      .select("id, label");
    if (variantError) throw new Error(variantError.message);

    summary.push({
      product_id: product.id,
      name: product.name,
      variants: (variants ?? []).map((v) => ({ id: v.id, label: v.label })),
    });
  }

  console.log(`Seeded catalog for ${business.name} (${business.id}):`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
