/**
 * SEC-1 — prove ai_model_config is unreachable to anon + sellers,
 * and that every public table has RLS enabled.
 *
 *   node scripts/verify-rls-config.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PILOT_SLUG = "ek-pousserd";

function loadEnv() {
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

const env = loadEnv();
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error("Missing Supabase env vars in .env.local");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now().toString(36);
const TAG = `rls-cfg-${stamp}`;
const SELLER = {
  email: `${TAG}@tradeflow-test.local`,
  password: `RlsCfg!${stamp}Aa1`,
  slug: TAG,
  name: `[SEC1] ${TAG}`,
};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function denied(error, data) {
  if (error) return true;
  if (Array.isArray(data) && data.length === 0) return true;
  if (data == null) return true;
  return false;
}

async function assertBlocked(client, label, op) {
  try {
    const { data, error } = await op(client);
    const ok = denied(error, data);
    record(
      label,
      ok,
      ok
        ? error?.message || "empty/denied"
        : `unexpected access: ${JSON.stringify(data)?.slice(0, 120)}`,
    );
  } catch (e) {
    record(label, true, e instanceof Error ? e.message : String(e));
  }
}

async function createSeller() {
  const { data, error } = await admin.auth.admin.createUser({
    email: SELLER.email,
    password: SELLER.password,
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user.id;

  const { data: biz, error: bizErr } = await admin
    .from("businesses")
    .insert({
      owner_user_id: userId,
      name: SELLER.name,
      slug: SELLER.slug,
    })
    .select("id, slug")
    .single();
  if (bizErr) throw bizErr;
  if (biz.slug === PILOT_SLUG) {
    throw new Error("Refusing to use pilot slug");
  }
  return { userId, businessId: biz.id };
}

async function signInSeller() {
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: SELLER.email,
    password: SELLER.password,
  });
  if (error) throw error;
  return client;
}

async function cleanup(userId, businessId) {
  try {
    if (businessId) {
      await admin.from("businesses").delete().eq("id", businessId);
    }
  } catch (e) {
    console.warn("cleanup business:", e instanceof Error ? e.message : e);
  }
  try {
    if (userId) {
      await admin.auth.admin.deleteUser(userId);
    }
  } catch (e) {
    console.warn("cleanup user:", e instanceof Error ? e.message : e);
  }
  // Sweep any leftover tagged shops (never pilot).
  const { data: leftovers } = await admin
    .from("businesses")
    .select("id, slug")
    .like("slug", "rls-cfg-%");
  for (const row of leftovers ?? []) {
    if (row.slug === PILOT_SLUG) continue;
    await admin.from("businesses").delete().eq("id", row.id);
  }
}

function checkAllTablesHaveRls() {
  const sqlPath = resolve(root, "scripts/_tmp-rls-enabled-check.sql");
  writeFileSync(
    sqlPath,
    `SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
ORDER BY 1;
`,
  );
  try {
    // Windows: shell + file arg (inline SQL breaks PowerShell quoting).
    const spawned = spawnSync(
      `npx supabase db query --remote --read-only -f "${sqlPath}" --output-format json`,
      { cwd: root, encoding: "utf8", shell: true },
    );
    const combined = `${spawned.stdout || ""}\n${spawned.stderr || ""}`;
    if (spawned.status !== 0) {
      record(
        "all public tables have RLS enabled",
        false,
        `db query failed (exit ${spawned.status}): ${combined.slice(0, 400)}`,
      );
      return;
    }
    let parsed;
    try {
      const from = combined.indexOf("{");
      if (from < 0) throw new Error("no JSON object in CLI output");
      // First top-level object only (CLI may append warnings after).
      let depth = 0;
      let end = -1;
      for (let i = from; i < combined.length; i++) {
        const ch = combined[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end < 0) throw new Error("unterminated JSON");
      parsed = JSON.parse(combined.slice(from, end));
    } catch (e) {
      record(
        "all public tables have RLS enabled",
        false,
        `parse failed: ${e instanceof Error ? e.message : e}; out=${combined.slice(0, 200)}`,
      );
      return;
    }
    const rows = parsed?.rows ?? [];
    record(
      "all public tables have RLS enabled",
      rows.length === 0,
      rows.length === 0
        ? "no public tables with RLS off"
        : `RLS off: ${rows.map((r) => r.table_name).join(", ")}`,
    );
  } finally {
    try {
      unlinkSync(sqlPath);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  let userId = null;
  let businessId = null;

  try {
    // --- anon cannot CRUD ai_model_config ---
    const anon = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    await assertBlocked(anon, "anon cannot SELECT ai_model_config", (c) =>
      c.from("ai_model_config").select("task_key").limit(5),
    );
    await assertBlocked(anon, "anon cannot INSERT ai_model_config", (c) =>
      c
        .from("ai_model_config")
        .insert({
          task_key: `sec1_probe_${randomUUID().slice(0, 8)}`,
          provider: "gemini",
          model: "gemini-2.5-flash",
          is_active: false,
        })
        .select("task_key"),
    );
    await assertBlocked(anon, "anon cannot UPDATE ai_model_config", (c) =>
      c
        .from("ai_model_config")
        .update({ is_active: false })
        .eq("task_key", "test_ping")
        .select("task_key"),
    );
    await assertBlocked(anon, "anon cannot DELETE ai_model_config", (c) =>
      c
        .from("ai_model_config")
        .delete()
        .eq("task_key", "test_ping")
        .select("task_key"),
    );

    // --- seller session (tagged shop) cannot CRUD ---
    const created = await createSeller();
    userId = created.userId;
    businessId = created.businessId;
    const seller = await signInSeller();

    // Sanity: seller can see own business (session works).
    {
      const { data, error } = await seller
        .from("businesses")
        .select("id, slug")
        .eq("id", businessId)
        .maybeSingle();
      record(
        "seller session can read own tagged shop",
        !error && data?.id === businessId && data?.slug !== PILOT_SLUG,
        error?.message || data?.slug,
      );
    }

    await assertBlocked(seller, "seller cannot SELECT ai_model_config", (c) =>
      c.from("ai_model_config").select("task_key").limit(5),
    );
    await assertBlocked(seller, "seller cannot INSERT ai_model_config", (c) =>
      c
        .from("ai_model_config")
        .insert({
          task_key: `sec1_seller_${randomUUID().slice(0, 8)}`,
          provider: "gemini",
          model: "gemini-2.5-flash",
          is_active: false,
        })
        .select("task_key"),
    );
    await assertBlocked(seller, "seller cannot UPDATE ai_model_config", (c) =>
      c
        .from("ai_model_config")
        .update({ max_tokens: 1 })
        .eq("task_key", "test_ping")
        .select("task_key"),
    );
    await assertBlocked(seller, "seller cannot DELETE ai_model_config", (c) =>
      c
        .from("ai_model_config")
        .delete()
        .eq("task_key", "test_ping")
        .select("task_key"),
    );

    // Service role still works (regression for gateway).
    {
      const { data, error } = await admin
        .from("ai_model_config")
        .select("task_key")
        .eq("task_key", "test_ping")
        .maybeSingle();
      record(
        "service role can SELECT ai_model_config",
        !error && data?.task_key === "test_ping",
        error?.message || data?.task_key,
      );
    }

    checkAllTablesHaveRls();
  } finally {
    await cleanup(userId, businessId);
  }

  const failed = results.filter((r) => !r.passed).length;
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nVERIFICATION: ${passed} PASSED, ${failed} FAILED`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
