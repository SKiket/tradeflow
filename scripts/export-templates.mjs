/**
 * Export draft WhatsApp templates for Twilio Content Template Builder,
 * or record a returned Content SID + meta_status (no network calls).
 *
 *   node scripts/export-templates.mjs
 *   node scripts/export-templates.mjs --record --key=order_dispatched --lang=en --sid=HXxxxx --status=approved
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
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
  return env;
}

const fileEnv = loadEnv();
for (const [k, v] of Object.entries(fileEnv)) {
  if (!process.env[k]) process.env[k] = v;
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function parseArgs(argv) {
  const out = { record: false, key: null, lang: null, sid: null, status: null };
  for (const a of argv) {
    if (a === "--record") out.record = true;
    else if (a.startsWith("--key=")) out.key = a.slice(6);
    else if (a.startsWith("--lang=")) out.lang = a.slice(7);
    else if (a.startsWith("--sid=")) out.sid = a.slice(6);
    else if (a.startsWith("--status=")) out.status = a.slice(9);
  }
  return out;
}

async function exportDrafts() {
  const { data, error } = await admin
    .from("message_templates")
    .select(
      "template_key, language, body, variable_names, category, meta_status, twilio_content_sid",
    )
    .eq("meta_status", "draft")
    .is("business_id", null)
    .order("template_key")
    .order("language");

  if (error) throw error;

  // Samples come from the registry file so export stays paste-ready even
  // before seed — fall back to placeholder if registry can't be read.
  const samplesByKey = loadSamplesFromRegistry();

  console.log("=".repeat(72));
  console.log("TWILIO CONTENT TEMPLATE BUILDER — paste each block below");
  console.log("=".repeat(72));

  for (const row of data ?? []) {
    const samples = samplesByKey[row.template_key] ?? {};
    const names = row.variable_names ?? [];
    console.log("\n---");
    console.log(`Key:          ${row.template_key}`);
    console.log(`Language:     ${row.language}`);
    console.log(`Category:     ${row.category}`);
    console.log(`Friendly name:${row.template_key}_${row.language}`);
    console.log("Body:");
    console.log(row.body);
    console.log("Variables (samples for Meta review):");
    if (names.length === 0) {
      console.log("  (none)");
    } else {
      names.forEach((name, i) => {
        const sample = samples[name] ?? `sample_${i + 1}`;
        console.log(`  {{${i + 1}}} ${name} = ${sample}`);
      });
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(`Exported ${(data ?? []).length} draft template(s).`);
  console.log(
    "After Twilio returns a Content SID, record it with:\n" +
      "  node scripts/export-templates.mjs --record --key=KEY --lang=en --sid=HXxxx --status=approved",
  );
}

function loadSamplesFromRegistry() {
  try {
    const src = readFileSync(
      resolve(root, "src/lib/channels/templates/registry.ts"),
      "utf8",
    );
    const out = {};
    const keyBlocks = src.split(/key:\s*"/).slice(1);
    for (const block of keyBlocks) {
      const key = block.slice(0, block.indexOf('"'));
      out[key] = {};
      const varRe = /name:\s*"([^"]+)"\s*,\s*sample:\s*"([^"]*)"/g;
      let m;
      while ((m = varRe.exec(block)) && block.indexOf("bodies:") > m.index) {
        out[key][m[1]] = m[2];
      }
      // Safer: only parse until bodies for this entry
      const untilBodies = block.split("bodies:")[0] ?? block;
      out[key] = {};
      const re = /name:\s*"([^"]+)"[\s\S]*?sample:\s*"([^"]*)"/g;
      let match;
      while ((match = re.exec(untilBodies))) {
        out[key][match[1]] = match[2];
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function recordSid(args) {
  const allowed = new Set(["draft", "submitted", "approved", "rejected"]);
  if (!args.key || !args.lang || !args.sid || !args.status) {
    console.error(
      "Usage: --record --key=KEY --lang=en|fr --sid=HXxxx --status=approved|submitted|rejected|draft",
    );
    process.exit(1);
  }
  if (!allowed.has(args.status)) {
    console.error(`Invalid status: ${args.status}`);
    process.exit(1);
  }

  const { data, error } = await admin
    .from("message_templates")
    .update({
      twilio_content_sid: args.sid,
      meta_status: args.status,
    })
    .eq("template_key", args.key)
    .eq("language", args.lang)
    .is("business_id", null)
    .select("id, template_key, language, twilio_content_sid, meta_status")
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    console.error(`No platform row for ${args.key}/${args.lang} — seed first.`);
    process.exit(1);
  }

  console.log("Recorded:");
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.record) {
    await recordSid(args);
  } else {
    await exportDrafts();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
