/**
 * Step 22c — sequential verify runner.
 *
 *   node scripts/verify-all.mjs
 *   node scripts/verify-all.mjs --only=verify-draft-order,verify-refunds
 *   node scripts/verify-all.mjs --baseline
 *   node scripts/verify-all.mjs --strict-known
 *
 * Seeds EK-Pousser_D first. Forces TWILIO_DRY_RUN=true for child scripts.
 * The Next.js server must also have TWILIO_DRY_RUN=true (see README).
 * Known failures (scripts/KNOWN_FAILURES.md) are reported as KNOWN.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg
  ? onlyArg
      .slice("--only=".length)
      .split(",")
      .map((s) => s.trim().replace(/\.mjs$/, "") + ".mjs")
      .filter(Boolean)
  : null;
const baseline = args.includes("--baseline");
const strictKnown = args.includes("--strict-known");

function loadEnvFile() {
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
  return env;
}

const fileEnv = loadEnvFile();
for (const [k, v] of Object.entries(fileEnv)) {
  if (!process.env[k]) process.env[k] = v;
}

process.env.TWILIO_DRY_RUN = "true";
delete process.env.TWILIO_SIMULATE_ERROR;
delete process.env.FORCE_REAL_SEND;

const FIXED_ORDER = [
  "verify-auth-flow.mjs",
  "verify-ai-gateway.mjs",
  "verify-rls.mjs",
  "verify-webhook-ingress.mjs",
  "verify-whatsapp-normalisation.mjs",
  "verify-whatsapp-send.mjs",
  "verify-cron-health.mjs",
  "verify-multi-shop-rls.mjs",
  "verify-multi-shop.mjs",
  "verify-settings.mjs",
  "verify-setup-checklist.mjs",
  "verify-storage-and-og.mjs",
  "verify-product-images.mjs",
  "verify-csv-import.mjs",
  "verify-storefront.mjs",
  "verify-storefront-checkout.mjs",
  "verify-order-parse.mjs",
  "verify-draft-order.mjs",
  "verify-support-catalog.mjs",
  "verify-support-reply.mjs",
  "verify-support-order-status.mjs",
  "verify-inbox.mjs",
  "verify-inbox-reply.mjs",
  "verify-confirm-payment.mjs",
  "verify-awaiting-payment-change.mjs",
  "verify-payment-chase.mjs",
  "verify-payment-chase-hardening.mjs",
  "verify-reservation-window.mjs"
  "verify-dispatch-deliver.mjs",
  "verify-shippo-dispatch.mjs",
  "verify-tracking.mjs",
  "verify-shipping-address.mjs",
  "verify-refunds.mjs",
  "verify-returns.mjs",
  "verify-cooling-off.mjs",
  "verify-fulfil-order.mjs",
  "verify-customers.mjs",
  "verify-low-stock-and-analytics.mjs",
  "verify-live-analytics.mjs",
  "verify-voice-note.mjs",
  "verify-buyer-i18n.mjs",
  "verify-i18n-lifecycle-texts.mjs",
  "verify-i18n-refund-only.mjs",
  "verify-product-knowledge.mjs",
  "verify-allergen-guardrail.mjs",
  "verify-whatsapp-cart.mjs",
  "verify-connect-payments-gate.mjs",
  "verify-pricing.mjs",
  "verify-billing.mjs",
  "verify-billing-enforcement.mjs",
  "verify-payment-intent.mjs",
  "verify-account-updated.mjs",
  "verify-disputes.mjs",
  "verify-dispute-recovery.mjs",
];

function parseKnownFailures() {
  const path = resolve(root, "scripts/KNOWN_FAILURES.md");
  if (!existsSync(path)) return new Map();
  const map = new Map();
  for (const block of readFileSync(path, "utf8").split(/\n##\s+/).slice(1)) {
    const lines = block.split("\n");
    const heading = lines[0].trim();
    const name = heading.endsWith(".mjs") ? heading : `${heading}.mjs`;
    const reason =
      lines
        .find((l) => l.startsWith("- Reason:"))
        ?.replace(/^- Reason:\s*/, "")
        .trim() ?? "known failure";
    const step =
      lines
        .find((l) => l.startsWith("- Owner step:"))
        ?.replace(/^- Owner step:\s*/, "")
        .trim() ?? "unknown";
    map.set(name, { reason, step });
  }
  return map;
}

function extractFailLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        /^FAIL\b/i.test(l) ||
        /SOME TESTS FAILED/i.test(l) ||
        /VERIFICATION:\s*[1-9]\d*\s*FAILED/i.test(l) ||
        /CSV IMPORT:\s*FAILED/i.test(l) ||
        /^FAILED:/i.test(l) ||
        /[^0-9]([1-9]\d*)\s+FAILED\b/i.test(l) ||
        /^[1-9]\d*\s+FAILED\b/i.test(l),
    )
    .slice(0, 12);
}

function runScript(name) {
  const started = Date.now();
  const out = spawnSync(process.execPath, [`scripts/${name}`], {
    cwd: root,
    env: { ...process.env, TWILIO_DRY_RUN: "true" },
    encoding: "utf8",
    timeout: 600_000,
  });
  const text = `${out.stdout || ""}\n${out.stderr || ""}`;
  const failLines = extractFailLines(text);
  const passed =
    out.status === 0 &&
    !/SOME TESTS FAILED|CSV IMPORT: FAILED|VERIFICATION:.*FAILED|^FAILED:/im.test(
      text,
    );
  return {
    name,
    passed,
    status: out.status,
    ms: Date.now() - started,
    failLines,
  };
}

const known = parseKnownFailures();
console.log("=== verify-all (Step 22c) ===");
console.log(`TWILIO_DRY_RUN=${process.env.TWILIO_DRY_RUN}`);
console.log(`BASE_URL=${process.env.BASE_URL ?? "http://localhost:3000"}`);

console.log("\n--- cleanup: cleanup-verify-leftovers.mjs --delete ---");
const cleanup = spawnSync(
  process.execPath,
  ["scripts/cleanup-verify-leftovers.mjs", "--delete"],
  { cwd: root, env: process.env, encoding: "utf8", timeout: 180_000 },
);
console.log((cleanup.stdout || "").trim().split(/\n/).slice(-8).join("\n"));

console.log("\n--- seed: seed-ek-pousser-catalog.mjs ---");
const seed = spawnSync(process.execPath, ["scripts/seed-ek-pousser-catalog.mjs"], {
  cwd: root,
  env: process.env,
  encoding: "utf8",
  timeout: 120_000,
});
if (seed.status !== 0) {
  console.error("SEED FAILED");
  console.error((seed.stdout || "") + (seed.stderr || ""));
  process.exit(1);
}
console.log("SEED OK");

let scripts = only ?? [...FIXED_ORDER];
if (!only) {
  const extras = readdirSync(resolve(root, "scripts"))
    .filter((f) => f.startsWith("verify-") && f.endsWith(".mjs"))
    .filter((f) => f !== "verify-all.mjs" && !FIXED_ORDER.includes(f))
    .sort();
  scripts = [...FIXED_ORDER, ...extras];
}
scripts = scripts.filter((n) => existsSync(resolve(root, "scripts", n)));

const results = [];
for (const name of scripts) {
  console.log(`\n===== ${name} =====`);
  const r = runScript(name);
  results.push(r);
  const preview = r.failLines[0] ? ` — ${r.failLines[0].slice(0, 120)}` : "";
  console.log(`${r.passed ? "PASS" : "FAIL"} (${Math.round(r.ms / 1000)}s)${preview}`);
  if (!r.passed) {
    for (const line of r.failLines.slice(0, 6)) console.log(`       ${line}`);
  }
}

const passes = results.filter((r) => r.passed);
const knownFails = results.filter((r) => !r.passed && known.has(r.name));
const realFails = results.filter((r) => !r.passed && !known.has(r.name));

console.log("\n===== RESULTS =====");
console.log("status\tscript\tnotes");
for (const r of results) {
  const k = known.get(r.name);
  const status = r.passed ? "PASS" : k ? "KNOWN" : "FAIL";
  const notes = r.passed
    ? ""
    : k
      ? `${k.step}: ${k.reason}`
      : (r.failLines[0] || `exit=${r.status}`).slice(0, 120);
  console.log(`${status}\t${r.name}\t${notes}`);
}

console.log(
  `\nTOTAL: ${passes.length} pass, ${realFails.length} fail, ${knownFails.length} known of ${results.length}`,
);

if (baseline) {
  const path = resolve(root, "scripts/_baseline-failures.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        head: spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).stdout.trim(),
        results: results.map((r) => ({
          name: r.name,
          passed: r.passed,
          status: r.status,
          failLines: r.failLines,
          known: known.has(r.name),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${path}`);
}

if (realFails.length > 0) process.exit(1);
if (strictKnown && knownFails.length > 0) process.exit(1);
process.exit(0);
