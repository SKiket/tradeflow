/**
 * Moves the Twilio WhatsApp sandbox number mapping to a target business by
 * name. Clears it from any other business first (the column has a unique
 * index). Run: node scripts/set-whatsapp-number.mjs "EK-Pousser_D"
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_NUMBER = "+14155238886";
const TARGET_NAME = process.argv[2] ?? "EK-Pousser_D";

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
  const { data: target, error } = await admin
    .from("businesses")
    .select("id, name")
    .eq("name", TARGET_NAME)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!target) throw new Error(`No business named "${TARGET_NAME}"`);

  // Clear the number from any business currently holding it.
  const { data: cleared } = await admin
    .from("businesses")
    .update({ whatsapp_phone_e164: null })
    .eq("whatsapp_phone_e164", SANDBOX_NUMBER)
    .neq("id", target.id)
    .select("id, name");
  for (const b of cleared ?? []) {
    console.log(`Cleared sandbox number from: ${b.name} (${b.id})`);
  }

  const { error: setError } = await admin
    .from("businesses")
    .update({ whatsapp_phone_e164: SANDBOX_NUMBER })
    .eq("id", target.id);
  if (setError) throw new Error(setError.message);

  console.log(`Set ${SANDBOX_NUMBER} on ${target.name} (${target.id})`);

  // Confirm final state.
  const { data: holders } = await admin
    .from("businesses")
    .select("name, whatsapp_phone_e164")
    .eq("whatsapp_phone_e164", SANDBOX_NUMBER);
  console.log("Now mapped to:", holders?.map((h) => h.name).join(", "));
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
