/**
 * Verifies WhatsApp outbound send:
 *  1. Error path — business with no whatsapp_phone_e164 throws clear typed error
 *  2. Real send via /api/internal/test-whatsapp-send (requires TO_PHONE env)
 *  3. Confirms outbound messages row
 *
 * Run:
 *   node scripts/verify-whatsapp-send.mjs
 *   $env:TO_PHONE="+447..."; node scripts/verify-whatsapp-send.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TO_PHONE = process.env.TO_PHONE ?? "";

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

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function main() {
  const { data: ownerBiz } = await admin
    .from("businesses")
    .select("owner_user_id")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!ownerBiz) throw new Error("EK-Pousser_D not found");

  const slug = `wa-send-err-${Date.now()}`;
  const { data: tempBiz, error: tempErr } = await admin
    .from("businesses")
    .insert({
      owner_user_id: ownerBiz.owner_user_id,
      name: "WA Send Error Test",
      slug,
      whatsapp_phone_e164: null,
    })
    .select("id")
    .single();
  if (tempErr) throw new Error(tempErr.message);

  try {
    const errRes = await fetch(`${BASE}/api/internal/test-whatsapp-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: tempBiz.id,
        toPhoneE164: "+447700900099",
        text: "should not send",
      }),
    });
    const errJson = await errRes.json();
    record(
      "Test 1: no whatsapp_phone_e164 → clear typed error (not silent)",
      errRes.status === 400 &&
        errJson.ok === false &&
        errJson.code === "WHATSAPP_NOT_CONFIGURED" &&
        typeof errJson.error === "string" &&
        errJson.error.includes("whatsapp_phone_e164"),
      JSON.stringify(errJson),
    );
  } finally {
    await admin.from("businesses").delete().eq("id", tempBiz.id);
  }

  if (!TO_PHONE) {
    console.log(
      "\nSKIP — real send (set TO_PHONE to your sandbox-joined WhatsApp E.164 number)",
    );
  } else {
    const text = `TradeFlow outbound test ${new Date().toISOString()}`;
    const sendRes = await fetch(`${BASE}/api/internal/test-whatsapp-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toPhoneE164: TO_PHONE, text }),
    });
    const sendJson = await sendRes.json();
    record(
      "Test 2: real send returns Twilio SID + status",
      sendRes.status === 200 &&
        sendJson.ok === true &&
        typeof sendJson.sid === "string" &&
        sendJson.sid.startsWith("SM") &&
        typeof sendJson.status === "string",
      JSON.stringify(sendJson),
    );

    if (sendJson.messageId) {
      const { data: row } = await admin
        .from("messages")
        .select(
          "id, business_id, direction, normalised_text, thread_id, raw_payload",
        )
        .eq("id", sendJson.messageId)
        .maybeSingle();
      record(
        "Test 3: outbound messages row persisted",
        !!row &&
          row.direction === "outbound" &&
          row.normalised_text === text &&
          row.thread_id === sendJson.threadId &&
          row.raw_payload?.sid === sendJson.sid,
        JSON.stringify(row),
      );
    } else {
      record(
        "Test 3: outbound messages row persisted",
        false,
        "No messageId returned from send",
      );
    }
  }

  console.log("\n========================================");
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "ALL RUN TESTS PASSED" : "SOME TESTS FAILED");
  console.log("========================================");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
