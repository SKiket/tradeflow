/**
 * Idempotent seed of message_templates from the code registry.
 * Updates body/variables ONLY when meta_status = 'draft'.
 * Never modifies submitted or approved rows.
 *
 *   npx --yes tsx scripts/seed-message-templates.mts
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import {
  OBSOLETE_TEMPLATE_KEYS,
  TEMPLATE_REGISTRY,
} from "../src/lib/channels/templates/registry.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env: Record<string, string> = {};
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
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  let upserted = 0;
  let skipped = 0;
  let deleted = 0;

  for (const key of OBSOLETE_TEMPLATE_KEYS) {
    const { data: removed, error } = await admin
      .from("message_templates")
      .delete()
      .eq("template_key", key)
      .eq("meta_status", "draft")
      .is("business_id", null)
      .select("id, language");
    if (error) throw error;
    for (const row of removed ?? []) {
      deleted += 1;
      console.log(`deleted obsolete draft ${key}/${row.language}`);
    }
  }

  for (const def of TEMPLATE_REGISTRY) {
    for (const language of ["en", "fr"] as const) {
      const body = def.bodies[language];
      const variable_names = def.variables.map((v) => v.name);

      const { data: existing } = await admin
        .from("message_templates")
        .select("id, meta_status, body, variable_names")
        .eq("template_key", def.key)
        .eq("language", language)
        .is("business_id", null)
        .maybeSingle();

      if (existing) {
        if (existing.meta_status !== "draft") {
          skipped += 1;
          console.log(
            `skipped ${def.key}/${language} (status=${existing.meta_status} — never modify)`,
          );
          continue;
        }

        const { error } = await admin
          .from("message_templates")
          .update({
            body,
            variable_names,
            category: def.category,
          })
          .eq("id", existing.id)
          .eq("meta_status", "draft");
        if (error) throw error;
        upserted += 1;
        console.log(`updated draft ${def.key}/${language}`);
        continue;
      }

      const { error } = await admin.from("message_templates").insert({
        template_key: def.key,
        language,
        body,
        variable_names,
        category: def.category,
        meta_status: "draft",
        business_id: null,
      });
      if (error) throw error;
      upserted += 1;
      console.log(`inserted ${def.key}/${language}`);
    }
  }

  console.log(
    `\nDone. upserted=${upserted} skipped=${skipped} deleted_obsolete=${deleted}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
