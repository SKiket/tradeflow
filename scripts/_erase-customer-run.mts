/**
 * Internal runner for erase-customer.mjs — do not call directly.
 * Args: <businessId> <customerId>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eraseCustomer } from "../src/lib/privacy/erase-customer.ts";

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

const businessId = process.argv[2];
const customerId = process.argv[3];
if (!businessId || !customerId) {
  console.error("missing ids");
  process.exit(1);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const result = await eraseCustomer(admin, {
  businessId,
  customerId,
  requestedBy: "operator",
});

if (!result.ok) {
  if ("blocked" in result && result.blocked) {
    console.error("BLOCKED:", result.reason);
    console.error("orders:", result.blockingOrderRefs.length);
    process.exit(2);
  }
  console.error("ERROR:", "error" in result ? result.error : "failed");
  process.exit(1);
}

console.log("OK erase", {
  alreadyErased: result.alreadyErased,
  counts: {
    messagesDeleted: result.counts.messagesDeleted,
    pendingReplaysDeleted: result.counts.pendingReplaysDeleted,
    ordersAnonymised: result.counts.ordersAnonymised,
    refundReasonsCleared: result.counts.refundReasonsCleared,
    customerAnonymised: result.counts.customerAnonymised,
    twilioMessagesDeleted: result.counts.twilio.messagesDeleted,
    twilioMediaDeleted: result.counts.twilio.mediaDeleted,
    twilioFailures: result.counts.twilio.failures,
  },
});
