import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eraseCustomer } from "../src/lib/privacy/erase-customer.ts";
import { purgeClosedShop } from "../src/lib/privacy/shop-lifecycle.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  let v = t.slice(eq + 1);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  const k = t.slice(0, eq);
  if (process.env[k] == null) process.env[k] = v;
}

const dryRun = process.argv.includes("--dry-run");
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: rows, error } = await admin
  .from("deletion_requests")
  .select("id, business_id, subject_type, subject_id, status")
  .eq("status", "completed")
  .order("completed_at", { ascending: true });

if (error) {
  console.error(error.message);
  process.exit(1);
}

let customers = 0;
let shops = 0;
let skipped = 0;
let failed = 0;

for (const row of rows ?? []) {
  if (row.subject_type === "customer") {
    customers += 1;
    if (dryRun) continue;
    if (!row.business_id) {
      skipped += 1;
      continue;
    }
    const result = await eraseCustomer(admin, {
      businessId: row.business_id as string,
      customerId: row.subject_id as string,
      requestedBy: "operator",
      recordRequest: false,
    });
    if (!result.ok) failed += 1;
  } else if (row.subject_type === "seller_account") {
    shops += 1;
    if (dryRun) continue;
    const result = await purgeClosedShop(admin, {
      businessId: row.subject_id as string,
      dryRun: false,
    });
    if (!result.ok) failed += 1;
  } else {
    skipped += 1;
  }
}

console.log("Reapply summary (counts only):", {
  dryRun,
  completedRequests: (rows ?? []).length,
  customerSubjects: customers,
  sellerAccountSubjects: shops,
  skipped,
  failed,
});
