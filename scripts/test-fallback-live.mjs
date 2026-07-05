/**
 * Fallback test for test_ping — run once, restores config after.
 * node scripts/test-fallback-live.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/internal/test-ai-gateway`;

const CORRECT = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  fallback_provider: "openai",
  fallback_model: "gpt-4o-mini",
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

async function callGateway(label) {
  const response = await fetch(ENDPOINT);
  const body = await response.json();
  console.log(`\n=== ${label} ===`);
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  return { response, body };
}

async function main() {
  // Step 1: break primary model only
  await setConfig({ model: "gemini-does-not-exist" });
  const { data: broken } = await admin
    .from("ai_model_config")
    .select("*")
    .eq("task_key", "test_ping")
    .single();
  console.log("Config during fallback test:", broken);

  const fallback = await callGateway("Fallback test (invalid primary model)");

  const checks = {
    primaryWouldFail: broken.model === "gemini-does-not-exist",
    httpOk: fallback.response.ok,
    validJson:
      fallback.body.ok === true &&
      fallback.body.data?.answer === "pong",
    usedFallback: fallback.body.usedFallback === true,
    servedByFallback:
      fallback.body.provider === CORRECT.fallback_provider &&
      fallback.body.model === CORRECT.fallback_model,
    notPrimaryProvider: fallback.body.provider !== broken.provider ||
      fallback.body.model !== broken.model,
  };

  console.log("\n=== Fallback checks ===");
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? "PASS" : "FAIL"} — ${k}`);
  }

  // Restore and confirm normal path
  await setConfig(CORRECT);
  console.log("\nConfig restored to:", CORRECT);

  const normal = await callGateway("Normal test (restored config)");
  const normalOk =
    normal.response.ok &&
    normal.body.ok === true &&
    normal.body.data?.answer === "pong";

  console.log(`\n${normalOk ? "PASS" : "FAIL"} — normal call after restore`);

  const allPass =
    Object.values(checks).every(Boolean) && normalOk;
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
