/**
 * Verifies AI gateway primary + fallback paths.
 * Requires API keys in .env.local and dev server running.
 * Run: node scripts/verify-ai-gateway.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const CORRECT_CONFIG = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  fallback_provider: "gemini",
  fallback_model: "gemini-2.5-flash",
};

function loadEnv() {
  const content = readFileSync(resolve(root, ".env.local"), "utf8");
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
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const keyStatus = {
  anthropic: !!env.ANTHROPIC_API_KEY,
  openai: !!env.OPENAI_API_KEY,
  gemini: !!env.GOOGLE_GENERATIVE_AI_API_KEY,
};

async function hitGateway(label) {
  const response = await fetch(`${BASE}/api/internal/test-ai-gateway`);
  const body = await response.json();
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(body, null, 2));
  return { response, body };
}

async function setTestPingConfig(overrides) {
  const { error } = await admin
    .from("ai_model_config")
    .update({ ...overrides, updated_at: new Date().toISOString() })
    .eq("task_key", "test_ping");
  if (error) throw error;
}

async function main() {
  console.log("API key status:", keyStatus);

  if (!keyStatus.anthropic && !keyStatus.openai && !keyStatus.gemini) {
    console.error("\nNo AI API keys in .env.local — add keys and re-run.");
    process.exit(1);
  }

  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    console.error("Dev server not running. Start with: npm run dev");
    process.exit(1);
  }

  const primary = await hitGateway("Primary path (correct config)");
  const primaryPass =
    primary.response.ok &&
    primary.body.ok === true &&
    primary.body.data?.answer === "pong";

  await setTestPingConfig({ model: "invalid-model-name-xyz" });
  const fallback = await hitGateway("Fallback path (invalid primary model)");
  const fallbackPass =
    fallback.response.ok &&
    fallback.body.ok === true &&
    fallback.body.usedFallback === true &&
    fallback.body.data?.answer === "pong";

  await setTestPingConfig(CORRECT_CONFIG);
  console.log("\n--- Config restored ---");

  console.log("\n========================================");
  console.log(`Primary test:  ${primaryPass ? "PASS" : "FAIL"}`);
  console.log(`Fallback test: ${fallbackPass ? "PASS" : "FAIL"}`);
  console.log("========================================");
  console.log("Live keys:", Object.entries(keyStatus).filter(([, v]) => v).map(([k]) => k).join(", ") || "none");

  process.exit(primaryPass && fallbackPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
