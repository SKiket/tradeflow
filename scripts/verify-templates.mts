/**
 * Step 16 template-aware sending verification (mocked Twilio — no real sends).
 *
 *   npx --yes tsx scripts/verify-templates.mts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import {
  clearLastTwilioRequest,
  getLastTwilioRequest,
  sendWhatsAppMessage,
  setTwilioPosterForTests,
} from "../src/lib/channels/send/twilio-whatsapp.ts";
import { countRecentDeliveryFailures } from "../src/lib/dashboard/delivery-failures.ts";
import { runWhatsAppDeliveryRetry } from "../src/lib/cron/whatsapp-delivery-retry.ts";

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

const results: Array<{ ok: boolean; name: string; detail: string }> = [];
function pass(name: string, detail = "") {
  results.push({ ok: true, name, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail = "") {
  results.push({ ok: false, name, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const EN_SID = "HXen0000000000000000000000000001";
const FR_SID = "HXfr0000000000000000000000000002";
const TEST_PHONE = "+447700900111";
const DRY_PHONE = "+447911111111"; // not reserved — dry-run / mock poster

async function ensureBusiness(): Promise<string> {
  const { data } = await admin
    .from("businesses")
    .select("id, whatsapp_phone_e164")
    .is("deleted_at", null)
    .not("whatsapp_phone_e164", "is", null)
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("No business with whatsapp_phone_e164");
  return data.id as string;
}

async function ensureCustomer(params: {
  businessId: string;
  phone: string;
  lang: string | null;
  lastMessageAt: string | null;
}): Promise<string> {
  const { data: existing } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", params.businessId)
    .eq("phone_e164", params.phone)
    .maybeSingle();

  if (existing) {
    await admin
      .from("customers")
      .update({
        preferred_language: params.lang,
        last_customer_message_at: params.lastMessageAt,
      })
      .eq("id", existing.id);
    return existing.id as string;
  }

  const { data, error } = await admin
    .from("customers")
    .insert({
      business_id: params.businessId,
      phone_e164: params.phone,
      preferred_language: params.lang,
      last_customer_message_at: params.lastMessageAt,
      channel_identifiers: { whatsapp: params.phone },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "customer create failed");
  return data.id as string;
}

async function upsertApprovedTemplate(params: {
  key: string;
  language: string;
  sid: string;
  body: string;
}) {
  const { data: existing } = await admin
    .from("message_templates")
    .select("id")
    .eq("template_key", params.key)
    .eq("language", params.language)
    .is("business_id", null)
    .maybeSingle();

  if (existing) {
    await admin
      .from("message_templates")
      .update({
        twilio_content_sid: params.sid,
        meta_status: "approved",
        body: params.body,
      })
      .eq("id", existing.id);
    return;
  }

  await admin.from("message_templates").insert({
    template_key: params.key,
    language: params.language,
    body: params.body,
    variable_names: ["orderRef", "url"],
    category: "utility",
    twilio_content_sid: params.sid,
    meta_status: "approved",
    business_id: null,
  });
}

async function clearApproved(key: string, language: string) {
  await admin
    .from("message_templates")
    .update({ meta_status: "draft", twilio_content_sid: null })
    .eq("template_key", key)
    .eq("language", language)
    .is("business_id", null);
}

async function main() {
  console.log("=== Step 16/16b template verify (mocked Twilio) ===\n");

  const businessId = await ensureBusiness();
  const captured: Array<ReturnType<typeof getLastTwilioRequest>> = [];

  setTwilioPosterForTests(async (req) => {
    captured.push(req);
    clearLastTwilioRequest();
    // also mirror into lastTwilioRequest via return path — store locally
    return { sid: `MOCK_${randomUUID().slice(0, 8)}`, status: "queued" };
  });

  // ---- 2. Flag ON, in window → free-form ----
  process.env.TEMPLATES_ENABLED = "true";
  delete process.env.TWILIO_SIMULATE_ERROR;
  captured.length = 0;

  const inWindowCustomer = await ensureCustomer({
    businessId,
    phone: DRY_PHONE,
    lang: "en",
    lastMessageAt: new Date().toISOString(),
  });

  await upsertApprovedTemplate({
    key: "order_delivered",
    language: "en",
    sid: EN_SID,
    body: "Your order {{1}} has been delivered. Track at {{2}} anytime.",
  });

  const r2 = await sendWhatsAppMessage({
    businessId,
    toPhoneE164: DRY_PHONE,
    text: "Your order TF-INWIN has been delivered!",
    customerId: inWindowCustomer,
    template: {
      key: "order_delivered",
      variables: { orderRef: "TF-INWIN", url: "https://example.com/t/TF-INWIN" },
    },
  });

  if (
    r2.sendMode === "freeform" &&
    captured.length === 1 &&
    captured[0]?.kind === "freeform"
  ) {
    pass("2. Flag ON, in window: free-form sent", `sid=${r2.sid}`);
  } else {
    fail(
      "2. Flag ON, in window: free-form sent",
      `mode=${r2.sendMode} captured=${JSON.stringify(captured[0])}`,
    );
  }

  // ---- 3. Outside window, approved EN → Content API ----
  captured.length = 0;
  const outsideCustomer = await ensureCustomer({
    businessId,
    phone: DRY_PHONE,
    lang: "en",
    lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });

  const r3 = await sendWhatsAppMessage({
    businessId,
    toPhoneE164: DRY_PHONE,
    text: "Your order TF-OUT has been delivered!",
    customerId: outsideCustomer,
    template: {
      key: "order_delivered",
      variables: { orderRef: "TF-OUT", url: "https://example.com/t/TF-OUT" },
    },
  });

  const c3 = captured[0];
  if (
    r3.sendMode === "template" &&
    c3?.kind === "template" &&
    c3.contentSid === EN_SID &&
    c3.contentVariables["1"] === "TF-OUT" &&
    c3.contentVariables["2"] === "https://example.com/t/TF-OUT"
  ) {
    pass("3. Outside window, approved EN: Content API", `sid=${c3.contentSid}`);
  } else {
    fail("3. Outside window, approved EN: Content API", JSON.stringify(c3));
  }

  // ---- 4a. FR template used ----
  captured.length = 0;
  await upsertApprovedTemplate({
    key: "order_delivered",
    language: "fr",
    sid: FR_SID,
    body: "Votre commande {{1}} a été livrée. Suivez sur {{2}}.",
  });
  await ensureCustomer({
    businessId,
    phone: DRY_PHONE,
    lang: "fr",
    lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });

  await sendWhatsAppMessage({
    businessId,
    toPhoneE164: DRY_PHONE,
    text: "FR freeform",
    customerId: outsideCustomer,
    template: {
      key: "order_delivered",
      variables: { orderRef: "TF-FR", url: "https://example.com/t/TF-FR" },
    },
  });

  if (captured[0]?.kind === "template" && captured[0].contentSid === FR_SID) {
    pass("4a. Buyer FR with FR template: FR sid used");
  } else {
    fail("4a. Buyer FR with FR template", JSON.stringify(captured[0]));
  }

  // ---- 4b. FR buyer, no FR template → EN fallback ----
  captured.length = 0;
  await clearApproved("order_delivered", "fr");
  await ensureCustomer({
    businessId,
    phone: DRY_PHONE,
    lang: "fr",
    lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });

  await sendWhatsAppMessage({
    businessId,
    toPhoneE164: DRY_PHONE,
    text: "FR freeform fallback",
    customerId: outsideCustomer,
    template: {
      key: "order_delivered",
      variables: { orderRef: "TF-FB", url: "https://example.com/t/TF-FB" },
    },
  });

  if (captured[0]?.kind === "template" && captured[0].contentSid === EN_SID) {
    pass("4b. No FR template: falls back to EN sid");
  } else {
    fail("4b. No FR template: EN fallback", JSON.stringify(captured[0]));
  }

  // ---- 5. Outside window, no approved template ----
  captured.length = 0;
  await clearApproved("order_delivered", "en");
  await ensureCustomer({
    businessId,
    phone: DRY_PHONE,
    lang: "en",
    lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });

  let failedMsgId = "";
  try {
    await sendWhatsAppMessage({
      businessId,
      toPhoneE164: DRY_PHONE,
      text: "Should not send",
      customerId: outsideCustomer,
      template: {
        key: "order_delivered",
        variables: { orderRef: "TF-NONE", url: "https://example.com" },
      },
    });
    fail("5. Outside window, no approved template", "expected throw");
  } catch (err) {
    const { data: failedRows } = await admin
      .from("messages")
      .select("id, delivery_status, delivery_error_code, delivery_error_text")
      .eq("business_id", businessId)
      .eq("customer_id", outsideCustomer)
      .eq("delivery_error_code", "outside_window_no_template")
      .order("created_at", { ascending: false })
      .limit(1);
    failedMsgId = (failedRows?.[0]?.id as string) ?? "";
    const banner = await countRecentDeliveryFailures(admin, businessId);
    if (
      captured.length === 0 &&
      failedRows?.[0]?.delivery_status === "failed" &&
      banner.count > 0 &&
      (banner.latestErrorText ?? "").includes("template")
    ) {
      pass(
        "5. No approved template: failed + banner",
        `code=${failedRows[0].delivery_error_code}; banner=${banner.count}`,
      );
    } else {
      fail(
        "5. No approved template",
        `err=${err instanceof Error ? err.message : err}; rows=${JSON.stringify(failedRows)}; banner=${JSON.stringify(banner)}; captured=${captured.length}`,
      );
    }
  }

  // ---- 6. Retry queued in window, due outside → template path ----
  await upsertApprovedTemplate({
    key: "order_delivered",
    language: "en",
    sid: EN_SID,
    body: "Your order {{1}} has been delivered. Track at {{2}} anytime.",
  });

  // Restore in-window, create a failed row with template stamped, then age window.
  await ensureCustomer({
    businessId,
    phone: DRY_PHONE,
    lang: "en",
    lastMessageAt: new Date().toISOString(),
  });

  // Insert a failed outbound that looks like it was queued while in-window.
  const threadId = randomUUID();
  const { data: queued, error: qErr } = await admin
    .from("messages")
    .insert({
      business_id: businessId,
      customer_id: outsideCustomer,
      channel: "whatsapp",
      direction: "outbound",
      normalised_text: "Queued deliver notice",
      thread_id: threadId,
      delivery_status: "failed",
      delivery_attempts: 1,
      next_retry_at: new Date(Date.now() - 60_000).toISOString(),
      delivery_audience: "buyer",
      delivery_error_code: "63038",
      delivery_error_text: "Daily message limit reached",
      raw_payload: {
        provider: "twilio",
        to: DRY_PHONE,
        from: "+14155238886",
        queued_at: new Date().toISOString(),
        template: {
          key: "order_delivered",
          variables: {
            orderRef: "TF-RETRY",
            url: "https://example.com/t/TF-RETRY",
          },
        },
      },
    })
    .select("id")
    .single();
  if (qErr || !queued) throw new Error(qErr?.message ?? "queue insert failed");

  await ensureCustomer({
    businessId,
    phone: DRY_PHONE,
    lang: "en",
    lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });

  captured.length = 0;
  const retryResult = await runWhatsAppDeliveryRetry(admin);
  const c6 = captured.find((c) => c?.kind === "template");
  if (
    retryResult.succeeded >= 1 &&
    c6?.kind === "template" &&
    c6.contentSid === EN_SID &&
    c6.contentVariables["1"] === "TF-RETRY"
  ) {
    pass("6. Retry due outside window: switches to template path");
  } else {
    fail(
      "6. Retry due outside window",
      `retry=${JSON.stringify(retryResult)} captured=${JSON.stringify(captured)}`,
    );
  }

  // ---- 7. Simulated +447700900xxx: no Twilio call ----
  captured.length = 0;
  const simCustomer = await ensureCustomer({
    businessId,
    phone: TEST_PHONE,
    lang: "en",
    lastMessageAt: new Date().toISOString(),
  });
  const r7 = await sendWhatsAppMessage({
    businessId,
    toPhoneE164: TEST_PHONE,
    text: "Simulated hello",
    customerId: simCustomer,
  });
  if (r7.simulated && captured.length === 0 && r7.deliveryStatus === "simulated") {
    pass("7. Simulated +447700900xxx: no Twilio call");
  } else {
    fail("7. Simulated path", `sim=${r7.simulated} captured=${captured.length}`);
  }

  // ---- 8. Tenant cannot read message_templates ----
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 50 });
  const seller = listed?.users?.find((u) => u.email?.includes("@"));
  if (!seller?.email) {
    fail("8. Tenant isolation", "no auth user to mint JWT");
  } else {
    // Reset password temporarily for a known test login if needed — use service
    // to generate a session via magic link is heavy; use admin to create a
    // short-lived client with a fresh password on a throwaway user.
    const email = `tpl-rls-${Date.now()}@tradeflow-test.local`;
    const password = "TplRls!12345";
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created.user) {
      fail("8. Tenant isolation", createErr?.message ?? "create user failed");
    } else {
      const tenant = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        anonKey,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { error: signErr } = await tenant.auth.signInWithPassword({
        email,
        password,
      });
      if (signErr) {
        fail("8. Tenant isolation", signErr.message);
      } else {
        const { data: rows, error: readErr } = await tenant
          .from("message_templates")
          .select("id")
          .limit(5);
        const denied =
          (rows?.length ?? 0) === 0 &&
          // PostgREST may return empty or permission error depending on grants
          (readErr != null || (rows?.length ?? 0) === 0);

        // Confirm service role can read (table exists in isolation check)
        const { data: svcRows, error: svcErr } = await admin
          .from("message_templates")
          .select("id")
          .limit(1);

        if (denied && !svcErr && (svcRows?.length ?? 0) >= 0) {
          pass(
            "8. message_templates in tenant-isolation check",
            `tenant_rows=${rows?.length ?? 0} err=${readErr?.message ?? "none"}; service_ok`,
          );
        } else {
          fail(
            "8. message_templates tenant isolation",
            `tenant=${JSON.stringify({ rows, readErr })} svc=${JSON.stringify({ svcRows, svcErr })}`,
          );
        }
      }
      await admin.auth.admin.deleteUser(created.user.id);
    }
  }

  // ---- 9. Seller alert outside window uses approved template ----
  const SELLER_SID = "HXseller000000000000000000000001";
  const SELLER_PHONE = "+447911111222";
  await upsertApprovedTemplate({
    key: "seller_new_order",
    language: "en",
    sid: SELLER_SID,
    body: "New order {{1}} from {{2}} for {{3}}. Open your TradeFlow dashboard to review it.",
  });
  // Seller phone customer outside window (never messaged / stale).
  await ensureCustomer({
    businessId,
    phone: SELLER_PHONE,
    lang: "en",
    lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  // Point business seller phone at dry-run number for this check.
  const { data: bizBefore } = await admin
    .from("businesses")
    .select("seller_whatsapp_phone_e164")
    .eq("id", businessId)
    .maybeSingle();
  const priorSellerPhone = bizBefore?.seller_whatsapp_phone_e164 as
    | string
    | null;
  await admin
    .from("businesses")
    .update({ seller_whatsapp_phone_e164: SELLER_PHONE })
    .eq("id", businessId);

  captured.length = 0;
  const sellerSend = await sendWhatsAppMessage({
    businessId,
    toPhoneE164: SELLER_PHONE,
    text: "New paid order TF-SELLER!",
    audience: "seller",
    templateLanguage: "en",
    template: {
      key: "seller_new_order",
      variables: {
        ref: "TF-SELLER",
        buyer: "+447700900999",
        total: "£12.00",
      },
    },
  });
  const c9 = captured[0];
  if (
    sellerSend.sendMode === "template" &&
    c9?.kind === "template" &&
    c9.contentSid === SELLER_SID &&
    c9.contentVariables["1"] === "TF-SELLER" &&
    c9.contentVariables["2"] === "+447700900999" &&
    c9.contentVariables["3"] === "£12.00"
  ) {
    pass("9. Seller alert outside window: approved template + vars");
  } else {
    fail("9. Seller alert template", JSON.stringify({ sellerSend, c9 }));
  }

  // ---- 10. Seller alert, no approved template ----
  await clearApproved("seller_new_order", "en");
  captured.length = 0;
  try {
    await sendWhatsAppMessage({
      businessId,
      toPhoneE164: SELLER_PHONE,
      text: "New paid order TF-NONE!",
      audience: "seller",
      template: {
        key: "seller_new_order",
        variables: { ref: "TF-NONE", buyer: "buyer", total: "£1.00" },
      },
    });
    fail("10. Seller no template", "expected throw");
  } catch {
    const { data: failedSeller } = await admin
      .from("messages")
      .select("delivery_error_code")
      .eq("business_id", businessId)
      .eq("delivery_error_code", "outside_window_no_template")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (captured.length === 0 && failedSeller) {
      pass("10. Seller no approved template → outside_window_no_template");
    } else {
      fail("10. Seller no template", JSON.stringify({ failedSeller, captured }));
    }
  }

  // ---- 11. return_approved / return_declined keys map correctly ----
  const { getTemplateDefinition } = await import(
    "../src/lib/channels/templates/registry.ts"
  );
  const approvedDef = getTemplateDefinition("return_approved");
  const declinedDef = getTemplateDefinition("return_declined");
  const obsolete = getTemplateDefinition("return_update");
  if (
    approvedDef?.variables.map((v) => v.name).join(",") === "orderRef,url" &&
    declinedDef?.variables.map((v) => v.name).join(",") === "orderRef" &&
    !obsolete
  ) {
    pass("11. return_approved / return_declined replace return_update");
  } else {
    fail("11. return template keys", "registry mismatch");
  }

  // ---- 12. Seed must not modify approved rows ----
  const protectedBody =
    "PROTECTED approved body {{1}} from {{2}} for {{3}}. Do not change.";
  await upsertApprovedTemplate({
    key: "seller_new_order",
    language: "en",
    sid: SELLER_SID,
    body: protectedBody,
  });
  const { spawnSync } = await import("node:child_process");
  const seed = spawnSync(
    "npx",
    ["--yes", "tsx", "scripts/seed-message-templates.mts"],
    { cwd: root, encoding: "utf8", shell: true },
  );
  const { data: afterSeed } = await admin
    .from("message_templates")
    .select("body, meta_status, twilio_content_sid")
    .eq("template_key", "seller_new_order")
    .eq("language", "en")
    .is("business_id", null)
    .maybeSingle();
  if (
    seed.status === 0 &&
    afterSeed?.meta_status === "approved" &&
    afterSeed.body === protectedBody &&
    afterSeed.twilio_content_sid === SELLER_SID &&
    /skipped seller_new_order\/en/.test(seed.stdout ?? "")
  ) {
    pass("12. Seed leaves approved rows untouched");
  } else {
    fail(
      "12. Seed approved safety",
      `status=${seed.status} row=${JSON.stringify(afterSeed)} out=${(seed.stdout ?? "").slice(-400)}`,
    );
  }

  // Restore business seller phone + clear verify approvals
  await admin
    .from("businesses")
    .update({ seller_whatsapp_phone_e164: priorSellerPhone })
    .eq("id", businessId);
  await clearApproved("order_delivered", "en");
  await clearApproved("order_delivered", "fr");
  await clearApproved("seller_new_order", "en");

  setTwilioPosterForTests(null);

  // Cleanup verify messages (best-effort)
  if (failedMsgId) {
    await admin.from("messages").delete().eq("id", failedMsgId);
  }
  if (queued?.id) {
    await admin.from("messages").delete().eq("id", queued.id);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n========================================");
  console.log(
    failed.length === 0
      ? "TEMPLATE VERIFY: PASSED"
      : `TEMPLATE VERIFY: FAILED (${failed.length})`,
  );
  console.log("========================================");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  setTwilioPosterForTests(null);
  console.error(err);
  process.exit(1);
});
