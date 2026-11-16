/**
 * Shared helpers for verify scripts (Step 22c).
 * Import from scripts with: import { ... } from "./lib/verify-harness.mjs"
 */
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEED_TAG = "[order_parse_seed]";
const PILOT_NAME = "EK-Pousser_D";

export function loadVerifyEnv() {
  const envPath = resolve(root, ".env.local");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }
  // Never hit real Twilio from verifies.
  process.env.TWILIO_DRY_RUN = "true";
  delete process.env.TWILIO_SIMULATE_ERROR;
  delete process.env.FORCE_REAL_SEND;
  return env;
}

export function newRunId(prefix = "vf") {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

export function createAdmin() {
  loadVerifyEnv();
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export function hashTag(runId) {
  return createHash("sha1").update(runId).digest("hex").slice(0, 10);
}

/** Mock UK phone in +4477009xxxxx from a run id (stable within the run). */
export function phoneFromRunId(runId, slot = 0) {
  const n = Number.parseInt(hashTag(`${runId}:${slot}`).slice(0, 5), 16) % 100000;
  return `+4477009${String(n).padStart(5, "0")}`;
}

/** Cascade-delete orders (and refunds/fraud/items/history); null out disputes. */
export async function deleteOrdersByIds(admin, orderIds) {
  const ids = (orderIds ?? []).filter(Boolean);
  if (!ids.length) return 0;
  await admin.from("order_refunds").delete().in("order_id", ids);
  await admin.from("fraud_warnings").delete().in("order_id", ids);
  await admin.from("disputes").update({ order_id: null }).in("order_id", ids);
  await admin.from("order_items").delete().in("order_id", ids);
  await admin.from("order_status_history").delete().in("order_id", ids);
  await admin.from("orders").delete().in("id", ids);
  return ids.length;
}

/** Delete orders for a buyer phone on a business, including refunds/history. */
export async function cleanBuyerOrders(admin, businessId, phoneE164) {
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", phoneE164);
  const ids = (customers ?? []).map((c) => c.id);
  if (!ids.length) return { customers: 0, orders: 0 };

  const { data: orders } = await admin
    .from("orders")
    .select("id")
    .eq("business_id", businessId)
    .in("customer_id", ids);
  const orderIds = (orders ?? []).map((o) => o.id);
  await deleteOrdersByIds(admin, orderIds);
  await admin.from("messages").delete().in("customer_id", ids);
  return { customers: ids.length, orders: orderIds.length };
}

/**
 * Delete PENDING_CONFIRMATION drafts for a buyer phone (and optional empty-item
 * leftovers). Safer than wiping all statuses when a case needs a clean slate
 * before asserting cancel / no payment-link behaviour.
 */
export async function cleanPendingDrafts(admin, businessId, phoneE164) {
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", phoneE164);
  const ids = (customers ?? []).map((c) => c.id);
  if (!ids.length) return 0;

  const { data: pending } = await admin
    .from("orders")
    .select("id")
    .eq("business_id", businessId)
    .eq("status", "PENDING_CONFIRMATION")
    .in("customer_id", ids);
  return deleteOrdersByIds(
    admin,
    (pending ?? []).map((o) => o.id),
  );
}

/**
 * Load active seed catalog products (non-deleted products + prefer live variants).
 * Re-seeds via seed-ek-pousser-catalog.mjs when empty.
 */
export async function ensureSeedCatalog(admin, businessId, {
  select = "id, name, price_pence, product_variants(id, label, stock_quantity, reserved_quantity, track_inventory, deleted_at)",
} = {}) {
  async function load() {
    const { data } = await admin
      .from("products")
      .select(select)
      .eq("business_id", businessId)
      .eq("active", true)
      .is("deleted_at", null)
      .ilike("description", `%${SEED_TAG}%`);
    return data ?? [];
  }

  let products = await load();
  const hasLiveVariant = products.some((p) =>
    (p.product_variants ?? []).some((v) => !v.deleted_at),
  );
  if (products.length && hasLiveVariant) return products;

  console.log("No live seed catalog — seeding…");
  const seeded = spawnSync("node", ["scripts/seed-ek-pousser-catalog.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  if (seeded.status !== 0) {
    throw new Error(seeded.stderr || seeded.stdout || "seed-ek-pousser-catalog failed");
  }
  products = await load();
  if (!products.some((p) => (p.product_variants ?? []).some((v) => !v.deleted_at))) {
    throw new Error("No catalog variant after seed");
  }
  return products;
}

export function liveVariants(product) {
  return (product?.product_variants ?? []).filter((v) => !v.deleted_at);
}

/** Delete a test business created by a verify (never the pilot). */
export async function deleteTestBusiness(admin, businessId, { ownerUserId } = {}) {
  if (!businessId) return;
  const { data: biz } = await admin
    .from("businesses")
    .select("id, name")
    .eq("id", businessId)
    .maybeSingle();
  if (!biz || biz.name === PILOT_NAME) {
    throw new Error("Refusing to delete pilot / missing business");
  }

  const { data: orders } = await admin
    .from("orders")
    .select("id")
    .eq("business_id", businessId);
  await deleteOrdersByIds(
    admin,
    (orders ?? []).map((o) => o.id),
  );

  for (const table of [
    "ai_knowledge_gaps",
    "ai_describe_usage",
    "analytics_cache",
    "pending_replays",
    "messages",
    "product_images",
    "product_variants",
    "products",
    "customers",
    "disputes",
    "fraud_warnings",
  ]) {
    const { error } = await admin.from(table).delete().eq("business_id", businessId);
    if (error && !/schema cache|does not exist/i.test(error.message)) {
      console.warn(`deleteTestBusiness ${table}: ${error.message}`);
    }
  }
  await admin.from("businesses").delete().eq("id", businessId);
  if (ownerUserId) {
    await admin.auth.admin.deleteUser(ownerUserId);
  }
}

export { SEED_TAG, PILOT_NAME, root as VERIFY_ROOT };
