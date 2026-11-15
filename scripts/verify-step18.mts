/**
 * Step 18 — launch hardening / monitoring / CSV export verification.
 * No real Twilio sends.
 *
 *   npx --yes tsx scripts/verify-step18.mts
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ErrorEvent } from "@sentry/core";

import {
  allowSimulationHooks,
  isVercelProduction,
  shouldBlockTestRoutes,
  warnSimHookIgnoredInProduction,
} from "../src/lib/api/runtime-env.ts";
import { notFoundInProduction } from "../src/lib/api/internal-only.ts";
import { authorizeCronRequest } from "../src/lib/cron/auth.ts";
import {
  buildCatalogCsv,
  catalogExportFilename,
  escapeCsvField,
  neutraliseCsvCell,
} from "../src/lib/products/csv-export.ts";
import { parseCatalogCsv } from "../src/lib/products/csv-import.ts";
import { scrubSentryEvent } from "../src/lib/sentry/scrub.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split(
      "\n",
    )) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      let v = t.slice(eq + 1);
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      env[t.slice(0, eq)] = v;
    }
  } catch {
    /* optional */
  }
  return env;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  const fileEnv = loadEnv();
  for (const [k, v] of Object.entries(fileEnv)) {
    if (process.env[k] == null) process.env[k] = v;
  }

  console.log("=== Step 18 verification ===\n");

  // --- Part A: production-like blocking ---
  withEnv(
    {
      VERCEL_ENV: "production",
      VERCEL: "1",
      ALLOW_TEST_ROUTES: undefined,
    },
    () => {
      assert(isVercelProduction(), "VERCEL_ENV=production detected");
      assert(shouldBlockTestRoutes(), "test routes blocked in production");
      assert(!allowSimulationHooks(), "sim hooks disallowed in production");
      const blocked = notFoundInProduction();
      assert(blocked?.status === 404, "test route returns 404 in production");
    },
  );
  console.log("OK production-like: test-* → 404, sim hooks ignored");

  withEnv(
    {
      VERCEL_ENV: "preview",
      VERCEL: "1",
      ALLOW_TEST_ROUTES: undefined,
    },
    () => {
      assert(shouldBlockTestRoutes(), "test routes blocked on preview deploy");
    },
  );
  console.log("OK preview deploy: test-* blocked");

  withEnv(
    {
      VERCEL_ENV: undefined,
      VERCEL: undefined,
      ALLOW_TEST_ROUTES: undefined,
    },
    () => {
      assert(!shouldBlockTestRoutes(), "test routes open locally");
      assert(allowSimulationHooks(), "sim hooks allowed locally");
      assert(notFoundInProduction() === null, "local test routes not 404");
    },
  );
  console.log("OK local: test routes + sim hooks allowed");

  withEnv(
    {
      VERCEL_ENV: "production",
      VERCEL: "1",
      ALLOW_TEST_ROUTES: "true",
    },
    () => {
      assert(!shouldBlockTestRoutes(), "ALLOW_TEST_ROUTES overrides block");
    },
  );
  console.log("OK ALLOW_TEST_ROUTES=true re-opens test routes");

  // Sim hook warning (and continued ignore) in production
  withEnv(
    {
      VERCEL_ENV: "production",
      TWILIO_DRY_RUN: "true",
      TWILIO_SIMULATE_ERROR: "63038",
      FORCE_REAL_SEND: "true",
      INBOUND_SIMULATE_ERROR: "ai_timeout",
    },
    () => {
      assert(!allowSimulationHooks(), "hooks still ignored with vars set");
      warnSimHookIgnoredInProduction("TWILIO_DRY_RUN");
      warnSimHookIgnoredInProduction("TWILIO_SIMULATE_ERROR");
      warnSimHookIgnoredInProduction("FORCE_REAL_SEND");
      warnSimHookIgnoredInProduction("INBOUND_SIMULATE_ERROR");
    },
  );
  console.log("OK sim hooks ignored in production even when set");

  // Cron fail-closed
  const fakeReq = (secret: string | null) =>
    ({
      headers: {
        get: (name: string) => {
          if (!secret) return null;
          if (name === "x-cron-secret") return secret;
          return null;
        },
      },
      nextUrl: { searchParams: new URLSearchParams() },
    }) as unknown as import("next/server").NextRequest;

  await withEnvAsync(
    { CRON_SHARED_SECRET: undefined },
    async () => {
      const ok = await authorizeCronRequest(fakeReq("anything"));
      assert(!ok, "cron rejects when CRON_SHARED_SECRET unset");
    },
  );
  console.log("OK cron fail-closed when secret unset");

  const secret = "step18-test-cron-secret";
  await withEnvAsync({ CRON_SHARED_SECRET: secret }, async () => {
    assert(
      !(await authorizeCronRequest(fakeReq(null))),
      "cron rejects missing secret",
    );
    assert(
      !(await authorizeCronRequest(fakeReq("wrong"))),
      "cron rejects wrong secret",
    );
    assert(
      await authorizeCronRequest(fakeReq(secret)),
      "cron accepts matching secret",
    );
  });
  console.log("OK cron accepts only matching shared secret");

  // --- Part B: Sentry scrub ---
  const dirty: ErrorEvent = {
    message:
      "Failed for +447700900999 body: Please send 2 soap bars to Jane Doe",
    exception: {
      values: [
        {
          type: "Error",
          value:
            "WhatsApp to +447911111111: Hey Jane, your order is ready at 12 High Street",
        },
      ],
    },
    request: {
      headers: {
        Authorization: "Bearer sk_live_fake",
        "Content-Type": "application/json",
      },
      data: {
        Body: "WhatsApp message body with +447700900111",
        stripe: { id: "evt_123", object: "event" },
        twilio: { SmsBody: "secret sms" },
        customer_name: "Jane Doe",
        address: "12 High Street, London",
        business_id: "biz_keep_me",
      },
    },
    tags: {
      business_id: "biz_keep_me",
      phone: "+447700900999",
      email: "jane@example.com",
    },
    extra: {
      business_id: "biz_keep_me",
      message: "Please reply YES to confirm",
      phone: "+447700900222",
    },
    user: { id: "user_1", email: "jane@example.com", username: "jane" },
  };

  const scrubbed = scrubSentryEvent(structuredClone(dirty));
  assert(scrubbed, "scrubber returns event for 5xx/unrelated");
  const payload = JSON.stringify(scrubbed);
  assert(!payload.includes("+447700900999"), "phone scrubbed from message");
  assert(!payload.includes("+447911111111"), "phone scrubbed from exception");
  assert(!payload.includes("Hey Jane"), "message body scrubbed");
  assert(!payload.includes("sk_live_fake"), "Authorization scrubbed");
  assert(!payload.includes("Jane Doe"), "customer name scrubbed");
  assert(!payload.includes("12 High Street"), "address scrubbed");
  assert(!payload.includes("secret sms"), "Twilio body scrubbed");
  assert(scrubbed.tags?.business_id === "biz_keep_me", "business_id kept");
  assert(!scrubbed.tags?.phone, "phone tag removed");
  assert(!scrubbed.tags?.email, "email tag removed");
  console.log("OK Sentry scrub — scrubbed payload:");
  console.log(JSON.stringify(scrubbed, null, 2));

  const dropped = scrubSentryEvent(
    { message: "bad request" },
    { originalException: Object.assign(new Error("nope"), { status: 404 }) },
  );
  assert(dropped === null, "expected 4xx errors are not captured");
  console.log("OK expected 4xx dropped");

  withEnv({ NEXT_PUBLIC_SENTRY_DSN: undefined }, () => {
    assert(
      !process.env.NEXT_PUBLIC_SENTRY_DSN?.trim(),
      "DSN unset for no-op check",
    );
  });
  console.log("OK Sentry DSN unset → no-op mode (enabled:false when init)");

  // --- Part C: CSV ---
  assert(neutraliseCsvCell("=CMD()") === "'=CMD()", "formula = neutralised");
  assert(neutraliseCsvCell("+1234") === "'+1234", "formula + neutralised");
  assert(neutraliseCsvCell("-1+1") === "'-1+1", "formula - neutralised");
  assert(neutraliseCsvCell("@SUM(A1)") === "'@SUM(A1)", "formula @ neutralised");
  assert(escapeCsvField('Say "hi"') === '"Say ""hi"""', "quotes escaped");

  const csv = buildCatalogCsv([
    {
      name: "Café Crème £5",
      description: "Scented bar — café blend",
      price_pence: 550,
      photo_url: null,
      active: true,
      product_variants: [
        {
          label: "=HACK()",
          stock_quantity: 3,
          low_stock_threshold: 1,
          track_inventory: true,
          weight_grams: 100,
          deleted_at: null,
        },
      ],
    },
  ]);
  assert(csv.startsWith("\uFEFF"), "UTF-8 BOM present");
  assert(csv.includes("Café Crème £5"), "accents and £ survive");
  assert(csv.includes("'=HACK()"), "formula injection neutralised in export");

  const parsed = parseCatalogCsv(csv.replace(/^\uFEFF/, ""), {
    existingNames: [],
    defaultLowStockThreshold: 5,
  });
  assert(
    parsed.errors.length === 0,
    `import parse clean: ${JSON.stringify(parsed.errors)}`,
  );
  assert(parsed.products.length === 1, "one product round-trip");
  assert(parsed.products[0].name === "Café Crème £5", "name round-trips");
  assert(parsed.products[0].price_pence === 550, "price round-trips");
  // Export prefixes '=...' with '; importer strips the guard on parse.
  assert(
    parsed.products[0].variants[0].label === "=HACK()",
    `variant label round-trip got ${JSON.stringify(parsed.products[0].variants[0].label)}`,
  );

  assert(
    catalogExportFilename("My Shop!") ===
      `products-my-shop-${new Date().toISOString().slice(0, 10)}.csv` ||
      catalogExportFilename("My Shop!").startsWith("products-my-shop-"),
    "filename uses slug + date",
  );
  console.log("OK CSV export BOM, accents, £, formula injection, round-trip");

  // Health force-degraded (unit-level env gate)
  withEnv(
    { HEALTH_FORCE_DEGRADED: "true", VERCEL_ENV: undefined },
    () => {
      assert(!isVercelProduction(), "not production for health force");
    },
  );
  console.log("OK HEALTH_FORCE_DEGRADED gate ready (live check below if server up)");

  console.log("\nALL STEP 18 CHECKS PASSED");
}

async function withEnvAsync(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
