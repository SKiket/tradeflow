/**
 * Gemini-only fallback test for test_ping.
 * node scripts/test-gemini-fallback.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/internal/test-ai-gateway`;

const CORRECT = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  fallback_provider: "gemini",
  fallback_model: "gemini-2.5-flash",
};

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function setConfig(overrides) {
  const { error } = await admin
    .from("ai_model_config")
    .update({ ...overrides, updated_at: new Date().toISOString() })
    .eq("task_key", "test_ping");
  if (error) throw error;
}

async function getConfig() {
  const { data, error } = await admin
    .from("ai_model_config")
    .select("*")
    .eq("task_key", "test_ping")
    .single();
  if (error) throw error;
  return data;
}

async function callGateway(label) {
  const response = await fetch(ENDPOINT);
  const body = await response.json();
  console.log(`\n=== ${label} ===`);
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  return { response, body };
}

async function main() {
  // Ensure correct baseline config
  await setConfig(CORRECT);
  console.log("Baseline config set:", CORRECT);

  // Step 1: invalid model only — provider stays gemini
  await setConfig({ model: "gemini-does-not-exist" });
  const broken = await getConfig();
  console.log("\nConfig during fallback test:", {
    provider: broken.provider,
    model: broken.model,
    fallback_provider: broken.fallback_provider,
    fallback_model: broken.fallback_model,
  });

  const fallback = await callGateway("Fallback test");

  const fallbackChecks = {
    providerStillGemini: broken.provider === "gemini",
    invalidPrimaryModel: broken.model === "gemini-does-not-exist",
    httpOk: fallback.response.ok,
    validPong: fallback.body.ok === true && fallback.body.data?.answer === "pong",
    usedFallback: fallback.body.usedFallback === true,
    servedByGeminiFallback:
      fallback.body.provider === "gemini" &&
      fallback.body.model === "gemini-2.5-flash",
  };

  console.log("\n=== Fallback checks ===");
  for (const [k, v] of Object.entries(fallbackChecks)) {
    console.log(`${v ? "PASS" : "FAIL"} — ${k}`);
  }

  // Step 3: restore model immediately
  await setConfig({ model: "gemini-2.5-flash" });
  const restored = await getConfig();
  console.log("\nConfig restored:", {
    provider: restored.provider,
    model: restored.model,
    fallback_provider: restored.fallback_provider,
    fallback_model: restored.fallback_model,
  });

  const normal = await callGateway("Normal call after restore");

  const normalChecks = {
    httpOk: normal.response.ok,
    validPong: normal.body.ok === true && normal.body.data?.answer === "pong",
    providerGemini: normal.body.provider === "gemini",
    modelFlash: normal.body.model === "gemini-2.5-flash",
    noFallback: normal.body.usedFallback === false,
  };

  console.log("\n=== Normal checks ===");
  for (const [k, v] of Object.entries(normalChecks)) {
    console.log(`${v ? "PASS" : "FAIL"} — ${k}`);
  }

  const allPass =
    Object.values(fallbackChecks).every(Boolean) &&
    Object.values(normalChecks).every(Boolean);

  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await setConfig(CORRECT);
    console.log("Emergency restore applied.");
  } catch {
    /* ignore */
  }
  process.exit(1);
});
