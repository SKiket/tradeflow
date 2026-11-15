/**
 * Conversation language follows the buyer (mocked Twilio / no real sends).
 *
 *   npx --yes tsx scripts/verify-conversation-language.mts
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { t } from "../src/lib/i18n/index.ts";
import {
  carriesClearLanguageSignal,
  getCustomerPreferredLanguage,
  heuristicLanguage,
  isAmbiguousLanguageMessage,
  isSubstantiveMessage,
  maybeUpdatePreferredLanguage,
} from "../src/lib/i18n/language.ts";
import { isNegativeReply } from "../src/lib/orders/detect-reply.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
  const tline = line.trim();
  if (!tline || tline.startsWith("#")) continue;
  const eq = tline.indexOf("=");
  if (eq === -1) continue;
  let v = tline.slice(eq + 1);
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (process.env[tline.slice(0, eq)] == null) {
    process.env[tline.slice(0, eq)] = v;
  }
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const results: Array<{ ok: boolean; name: string }> = [];
function pass(name: string) {
  results.push({ ok: true, name });
  console.log(`PASS  ${name}`);
}
function fail(name: string, detail = "") {
  results.push({ ok: false, name });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function ensureCustomer(phone: string): Promise<{
  id: string;
  businessId: string;
}> {
  const { data: business } = await admin
    .from("businesses")
    .select("id")
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (!business?.id) throw new Error("No business");

  const { data: existing } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", phone)
    .maybeSingle();

  if (existing) {
    await admin
      .from("customers")
      .update({ preferred_language: null })
      .eq("id", existing.id);
    return { id: existing.id as string, businessId: business.id as string };
  }

  const { data, error } = await admin
    .from("customers")
    .insert({
      business_id: business.id,
      phone_e164: phone,
      preferred_language: null,
      channel_identifiers: { whatsapp: phone },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "customer create");
  return { id: data.id as string, businessId: business.id as string };
}

async function main() {
  console.log("=== Conversation language verify ===\n");

  // D1 compatibility: substantive still 3+ words
  if (
    !isSubstantiveMessage("ok") &&
    !isSubstantiveMessage("3 mugs") &&
    isSubstantiveMessage("I want 3 mugs")
  ) {
    pass("D1 substantive rule unchanged (ok / 3 mugs / I want 3 mugs)");
  } else {
    fail("D1 substantive rule unchanged");
  }

  // Heuristics + clear signal
  if (
    heuristicLanguage("Je voudrais 2 tasses bleues") === "fr" &&
    heuristicLanguage("Deux tasses") === "fr" &&
    heuristicLanguage("2 tasses") === "fr" &&
    heuristicLanguage("I want 2 blue mugs") === "en" &&
    heuristicLanguage("Oui") === null &&
    isAmbiguousLanguageMessage("Oui") &&
    isAmbiguousLanguageMessage("2") &&
    isAmbiguousLanguageMessage("ok") &&
    !isAmbiguousLanguageMessage("Deux tasses") &&
    carriesClearLanguageSignal({
      text: "Deux tasses",
      detectedLanguage: "fr",
    }) &&
    !carriesClearLanguageSignal({ text: "Oui", detectedLanguage: "fr" })
  ) {
    pass("heuristics + clear/ambiguous signals");
  } else {
    fail("heuristics + clear/ambiguous signals");
  }

  // Correction vs cancel
  if (
    isNegativeReply("non") &&
    isNegativeReply("non merci") &&
    !isNegativeReply("Non, 1 tasse plutôt")
  ) {
    pass("negative: short cancel vs French correction");
  } else {
    fail("negative: short cancel vs French correction");
  }

  const phone = `+4477009003${String(10 + (Date.now() % 80)).padStart(2, "0")}`;
  const { id: customerId } = await ensureCustomer(phone);

  // 1. New buyer, first French message (long)
  await admin
    .from("customers")
    .update({ preferred_language: null })
    .eq("id", customerId);
  const lang1 = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "Je voudrais 2 tasses bleues",
    detectedLanguage: "fr",
  });
  const draft1 = t("draft.confirmation", lang1, {
    items: "• 2× Classic Blue Mug",
    total: "£24.00",
  });
  const pay1 = t("confirm.payment_link", lang1, {
    url: "https://pay.example/1",
    hours: 24,
  });
  const chase1 = t("chase.reminder_12h_with_url", lang1, {
    url: "https://pay.example/1",
  });
  if (
    lang1 === "fr" &&
    /Voici le brouillon|Répondez OUI/i.test(draft1) &&
    /lien de paiement/i.test(pay1) &&
    /lien de paiement/i.test(chase1)
  ) {
    pass("1. New FR buyer → draft/payment/chase French");
  } else {
    fail("1. New FR buyer", `${lang1} ${draft1.slice(0, 80)}`);
  }

  // 5. Two-word French from new buyer
  await admin
    .from("customers")
    .update({ preferred_language: null })
    .eq("id", customerId);
  const lang5 = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "Deux tasses",
    detectedLanguage: heuristicLanguage("Deux tasses"),
  });
  const draft5 = t("draft.confirmation", lang5, {
    items: "• 2× Classic Blue Mug",
    total: "£24.00",
  });
  if (lang5 === "fr" && /Voici le brouillon/i.test(draft5)) {
    pass("5. Deux tasses (2 words) → French");
  } else {
    fail("5. Deux tasses", `${lang5}`);
  }

  // Also "2 tasses" with AI fr
  await admin
    .from("customers")
    .update({ preferred_language: "en" })
    .eq("id", customerId);
  const lang2t = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "2 tasses",
    detectedLanguage: "fr",
  });
  if (lang2t === "fr") pass('repro: "2 tasses" flips en→fr');
  else fail('repro: "2 tasses" flips en→fr', lang2t);

  // 2. Previously EN, then French 3+ words → switch
  await admin
    .from("customers")
    .update({ preferred_language: "en" })
    .eq("id", customerId);
  const lang2 = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "Je voudrais une tasse bleue",
    detectedLanguage: "fr",
  });
  if (lang2 === "fr") pass("2. EN then French 3+ → switches to FR");
  else fail("2. EN then French 3+", lang2);

  // 3. Short ambiguous in French conversation stays FR
  const lang3 = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "Oui",
    detectedLanguage: "en",
  });
  const lang3b = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "2",
    detectedLanguage: "en",
  });
  const lang3c = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "ok",
    detectedLanguage: "en",
  });
  const stored3 = await getCustomerPreferredLanguage(admin, customerId);
  if (
    lang3 === "fr" &&
    lang3b === "fr" &&
    lang3c === "fr" &&
    stored3 === "fr"
  ) {
    pass("3. Oui/2/ok in FR conversation stay French");
  } else {
    fail("3. short ambiguous stay FR", `${lang3}/${lang3b}/${lang3c}/${stored3}`);
  }

  // 4. Clear English sentence switches
  const lang4 = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "Actually I want two blue mugs please",
    detectedLanguage: "en",
  });
  if (lang4 === "en") pass("4. Clear English sentence switches to EN");
  else fail("4. switch to EN", lang4);

  // 7. Spanish: AI would follow; fixed messages English fallback
  await admin
    .from("customers")
    .update({ preferred_language: null })
    .eq("id", customerId);
  const lang7 = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId,
    messageText: "Quiero dos tazas azules por favor",
    detectedLanguage: "es",
  });
  const fixed7 = t("draft.confirmation", lang7, {
    items: "• 2× Mug",
    total: "£24.00",
  });
  const { data: row7 } = await admin
    .from("customers")
    .select("preferred_language")
    .eq("id", customerId)
    .single();
  if (
    row7?.preferred_language === "es" &&
    lang7 === "en" && // resolveLang for fixed msgs
    /Here's your draft order/i.test(fixed7)
  ) {
    pass("7. Spanish stored; fixed messages English fallback");
  } else {
    fail(
      "7. Spanish",
      `stored=${row7?.preferred_language} resolve=${lang7} text=${fixed7.slice(0, 60)}`,
    );
  }

  // 6. Retry/replay uses stored language at send time
  await admin
    .from("customers")
    .update({ preferred_language: "fr" })
    .eq("id", customerId);
  const replayLang = await getCustomerPreferredLanguage(admin, customerId);
  const replayText = t("support.processing_apology", replayLang);
  if (replayLang === "fr" && /désolé|Désolé|problème/i.test(replayText)) {
    pass("6. Replay/retry reads FR from customer at send time");
  } else {
    fail("6. replay FR", replayText);
  }

  // Chase URL fallback i18n
  const urlFr = t("chase.reminder_url_fallback", "fr");
  const urlEn = t("chase.reminder_url_fallback", "en");
  if (/répondez/i.test(urlFr) && /reply to this chat/i.test(urlEn)) {
    pass("chase URL fallback is language-aware");
  } else {
    fail("chase URL fallback");
  }

  console.log("\n========================================");
  const all = results.every((r) => r.ok);
  console.log(all ? "ALL CONVERSATION LANGUAGE CHECKS PASSED" : "SOME CHECKS FAILED");
  console.log("========================================");
  process.exit(all ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
