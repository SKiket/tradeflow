/**
 * Subject-access export for one buyer (operator).
 *
 *   node scripts/export-customer-data.mjs --business=<slug> --phone=<E164>
 *
 * Writes JSON to ./exports/customer-<businessIdShort>-<customerIdShort>.json
 * (contains personal data — handle securely).
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, eq)] = v;
  }
  return env;
}

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const slug = arg("business");
const phone = arg("phone");
if (!slug || !phone) {
  console.error(
    "Usage: node scripts/export-customer-data.mjs --business=<slug> --phone=<E164>",
  );
  process.exit(1);
}

const fileEnv = loadEnv();
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] == null) process.env[k] = v;
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: business } = await admin
  .from("businesses")
  .select("id, slug, name")
  .eq("slug", slug)
  .maybeSingle();

if (!business) {
  console.error("Business not found");
  process.exit(1);
}

const { data: customer } = await admin
  .from("customers")
  .select("*")
  .eq("business_id", business.id)
  .eq("phone_e164", phone)
  .maybeSingle();

if (!customer) {
  console.error("Customer not found");
  process.exit(1);
}

const { data: orders } = await admin
  .from("orders")
  .select("*, order_items(*), order_refunds(*)")
  .eq("business_id", business.id)
  .eq("customer_id", customer.id);

const { data: messages } = await admin
  .from("messages")
  .select(
    "id, direction, normalised_text, created_at, source_kind, media_urls, ai_parse_result, delivery_status",
  )
  .eq("business_id", business.id)
  .eq("customer_id", customer.id)
  .order("created_at", { ascending: true });

const payload = {
  exported_at: new Date().toISOString(),
  business: { id: business.id, slug: business.slug, name: business.name },
  customer,
  orders: orders ?? [],
  messages: messages ?? [],
};

const outDir = resolve(root, "exports");
mkdirSync(outDir, { recursive: true });
const shortBiz = String(business.id).replace(/-/g, "").slice(0, 8);
const shortCust = String(customer.id).replace(/-/g, "").slice(0, 8);
const outPath = resolve(outDir, `customer-${shortBiz}-${shortCust}.json`);
writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

console.log("Wrote export:", outPath);
console.log("Counts:", {
  orders: (orders ?? []).length,
  messages: (messages ?? []).length,
});
