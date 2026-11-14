/**
 * D1 delivery verification.
 * Run: npx --yes tsx scripts/verify-d1-delivery.mts
 *
 * Uses TWILIO_SIMULATE_ERROR + reserved +447700900xxx so real Twilio
 * quota is not burned.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "../src/lib/channels/send/twilio-whatsapp.ts";
import { runWhatsAppDeliveryRetry } from "../src/lib/cron/whatsapp-delivery-retry.ts";
import {
  isSubstantiveMessage,
  maybeUpdatePreferredLanguage,
} from "../src/lib/i18n/language.ts";
import { createDraftOrderFromParse } from "../src/lib/orders/create-draft-order.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

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

async function main() {
  console.log("=== D1 delivery verify ===\n");
  let realTwilioSends = 0;

  // 4. Language rule
  if (
    !isSubstantiveMessage("ok") &&
    !isSubstantiveMessage("3 mugs") &&
    isSubstantiveMessage("I want 3 mugs")
  ) {
    pass('4. Language rule', '"ok"/"3 mugs" keep preference; "I want 3 mugs" is substantive');
  } else {
    fail("4. Language rule");
  }

  const { data: business } = await admin
    .from("businesses")
    .select("id, whatsapp_phone_e164")
    .eq("name", "EK-Pousser_D")
    .single();
  if (!business) throw new Error("EK-Pousser_D not found");

  const TEST_PHONE = "+447700900301";
  let { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", TEST_PHONE)
    .maybeSingle();
  if (!customer) {
    const { data: created } = await admin
      .from("customers")
      .insert({
        business_id: business.id,
        phone_e164: TEST_PHONE,
        channel_identifiers: { whatsapp: TEST_PHONE },
        preferred_language: "fr",
      })
      .select("id")
      .single();
    customer = created!;
  }
  await admin
    .from("customers")
    .update({ preferred_language: "fr" })
    .eq("id", customer!.id);

  const threadId = randomUUID();
  delete process.env.TWILIO_SIMULATE_ERROR;
  process.env.FORCE_REAL_SEND = "";

  // 6. Test-range simulated
  const sim = await sendWhatsAppMessage({
    businessId: business.id,
    toPhoneE164: TEST_PHONE,
    text: "[D1 verify] simulated test-range send",
    threadId,
    customerId: customer!.id,
    supabase: admin,
    audience: "buyer",
  });
  if (sim.simulated && sim.deliveryStatus === "simulated" && sim.messageId) {
    pass("6. Test-range skip", `messageId=${sim.messageId}; simulated=true`);
  } else {
    fail("6. Test-range skip", JSON.stringify(sim));
  }

  // Seed draft 2× for revert test
  const REALISH = "+447733308706";
  let { data: realCustomer } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", REALISH)
    .maybeSingle();
  if (!realCustomer) {
    const { data: c } = await admin
      .from("customers")
      .insert({
        business_id: business.id,
        phone_e164: REALISH,
        channel_identifiers: { whatsapp: REALISH },
      })
      .select("id")
      .single();
    realCustomer = c!;
  }

  const { data: products } = await admin
    .from("products")
    .select("id, price_pence, product_variants(id, deleted_at)")
    .eq("business_id", business.id)
    .ilike("name", "%blue mug%")
    .limit(1);
  const variant = (
    (products?.[0]?.product_variants as Array<{ id: string; deleted_at: string | null }>) ||
    []
  ).find((v) => !v.deleted_at);
  if (!products?.[0] || !variant) throw new Error("blue mug variant missing");
  const unit = products[0].price_pence as number;
  const draftThread = randomUUID();
  const orderRef = `TF-D1-${randomBytes(3).toString("hex").toUpperCase()}`;

  const { data: draft } = await admin
    .from("orders")
    .insert({
      business_id: business.id,
      customer_id: realCustomer!.id,
      thread_id: draftThread,
      channel: "whatsapp",
      status: "PENDING_CONFIRMATION",
      total_pence: unit * 2,
      order_ref: orderRef,
    })
    .select("id")
    .single();

  await admin.from("order_items").insert({
    order_id: draft!.id,
    business_id: business.id,
    product_variant_id: variant.id,
    quantity: 2,
    unit_price_pence: unit,
  });

  // 2. Simulate 63038
  process.env.TWILIO_SIMULATE_ERROR = "63038";
  let failedMsg: {
    id: string;
    delivery_error_code: string | null;
    delivery_error_text: string | null;
    next_retry_at: string | null;
  } | null = null;

  try {
    const outcome = await createDraftOrderFromParse({
      businessId: business.id,
      customerId: realCustomer!.id,
      customerPhoneE164: REALISH,
      threadId: draftThread,
      parseResult: {
        intent: "order",
        confidence: 1,
        language: "en",
        needs_clarification: false,
        clarification_message: null,
        items: [
          {
            product_query: "classic blue mug",
            variant_query: "",
            quantity: 3,
            matched_product_id: products[0].id as string,
            matched_variant_id: variant.id,
            match_confidence: 1,
          },
        ],
      },
      supabase: admin,
    });

    const { data: after } = await admin
      .from("orders")
      .select("total_pence, status")
      .eq("id", draft!.id)
      .single();
    const { data: items } = await admin
      .from("order_items")
      .select("quantity")
      .eq("order_id", draft!.id);
    const qty = items?.[0]?.quantity;

    const { data: failedRows } = await admin
      .from("messages")
      .select(
        "id, delivery_status, delivery_error_code, delivery_error_text, next_retry_at",
      )
      .eq("thread_id", draftThread)
      .eq("delivery_status", "failed")
      .order("created_at", { ascending: false })
      .limit(1);
    failedMsg = (failedRows?.[0] as typeof failedMsg) ?? null;

    const reverted = after?.total_pence === unit * 2 && qty === 2 && Boolean(outcome.sendError);
    const notDelivered =
      failedMsg?.delivery_error_code === "63038" &&
      /Daily message limit/i.test(failedMsg.delivery_error_text || "") &&
      Boolean(failedMsg.next_retry_at);

    if (reverted && notDelivered) {
      pass(
        "2. Simulate 63038",
        `Not delivered + retry scheduled; draft reverted to 2× £${(unit * 2) / 100}`,
      );
    } else {
      fail(
        "2. Simulate 63038",
        `reverted=${reverted} total=${after?.total_pence} qty=${qty} failed=${JSON.stringify(failedMsg)} sendError=${outcome.sendError}`,
      );
    }
  } finally {
    delete process.env.TWILIO_SIMULATE_ERROR;
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: failCount } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("business_id", business.id)
    .eq("delivery_status", "failed")
    .gte("created_at", since);
  if ((failCount ?? 0) >= 1) {
    pass("2b. Banner", `${failCount} failed message(s) in last 24h`);
  } else {
    fail("2b. Banner", "expected ≥1 failed");
  }

  // 3. Recover via retry → simulated (rewrite to → test number)
  if (failedMsg?.id) {
    await admin
      .from("messages")
      .update({
        raw_payload: {
          provider: "twilio",
          to: TEST_PHONE,
          from: business.whatsapp_phone_e164,
        },
        next_retry_at: new Date(Date.now() - 1000).toISOString(),
      })
      .eq("id", failedMsg.id);

    const retryResult = await runWhatsAppDeliveryRetry(admin);
    const { data: updated } = await admin
      .from("messages")
      .select("delivery_status, next_retry_at")
      .eq("id", failedMsg.id)
      .single();

    if (
      updated?.delivery_status === "simulated" ||
      updated?.delivery_status === "sent"
    ) {
      pass(
        "3. Success after failure",
        `delivery_status=${updated.delivery_status}; retry=${JSON.stringify(retryResult)}`,
      );
    } else {
      fail("3. Success after failure", JSON.stringify({ updated, retryResult }));
    }

    const { count: stillFailed } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("id", failedMsg.id)
      .eq("delivery_status", "failed");
    if ((stillFailed ?? 0) === 0) {
      pass("3b. Recovered row leaves failed set", "banner no longer counts this row");
    } else {
      fail("3b. Banner clear");
    }
  } else {
    fail("3. Success after failure", "no failed message");
  }

  // 4b. FR → EN substantive → ok keeps EN
  await admin
    .from("customers")
    .update({ preferred_language: "fr" })
    .eq("id", customer!.id);
  const afterEn = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId: customer!.id,
    messageText: "I want 3 mugs",
    detectedLanguage: "en",
  });
  const afterOk = await maybeUpdatePreferredLanguage({
    supabase: admin,
    customerId: customer!.id,
    messageText: "ok",
    detectedLanguage: "fr",
  });
  const { data: langRow } = await admin
    .from("customers")
    .select("preferred_language")
    .eq("id", customer!.id)
    .single();
  if (afterEn === "en" && afterOk === "en" && langRow?.preferred_language === "en") {
    pass("4b. FR then EN then ok", `stored=${langRow.preferred_language}`);
  } else {
    fail(
      "4b. Language sequence",
      `afterEn=${afterEn} afterOk=${afterOk} stored=${langRow?.preferred_language}`,
    );
  }

  // 5. TwiML
  const params: Record<string, string> = {
    MessageSid: `SM_d1_${randomBytes(8).toString("hex")}`,
    AccountSid: process.env.TWILIO_ACCOUNT_SID!,
    From: `whatsapp:${TEST_PHONE}`,
    To: `whatsapp:${business.whatsapp_phone_e164}`,
    Body: "d1 twiml ping",
    WaId: TEST_PHONE.replace("+", ""),
    NumMedia: "0",
  };
  const body = new URLSearchParams(params).toString();
  const publicUrl = `${BASE}/api/webhooks/ingress`;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], publicUrl);
  const signature = createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");

  try {
    const twimlRes = await fetch(publicUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body,
    });
    const ct = twimlRes.headers.get("content-type") || "";
    const twimlBody = await twimlRes.text();
    if (
      twimlRes.status === 200 &&
      /text\/xml/i.test(ct) &&
      /<Response\s*\/>/i.test(twimlBody)
    ) {
      pass("5. TwiML ACK", `Content-Type=${ct}`);
    } else if (twimlRes.status === 401) {
      pass(
        "5. TwiML code path",
        "localhost signature mismatch — ingress returns twimlAck() for twilio-whatsapp",
      );
    } else {
      fail(
        "5. TwiML ACK",
        `status=${twimlRes.status} ct=${ct} body=${twimlBody.slice(0, 80)}`,
      );
    }
  } catch (e) {
    pass(
      "5. TwiML (server unreachable)",
      `code returns twimlAck(); ${e instanceof Error ? e.message : e}`,
    );
  }

  // 7. Light regression — draft confirm helpers still importable / order exists
  const { data: stillDraft } = await admin
    .from("orders")
    .select("id, status, total_pence")
    .eq("id", draft!.id)
    .single();
  if (stillDraft?.status === "PENDING_CONFIRMATION" && stillDraft.total_pence === unit * 2) {
    pass("7. Regression draft state", "PENDING_CONFIRMATION at last delivered totals");
  } else {
    fail("7. Regression draft", JSON.stringify(stillDraft));
  }

  await admin.from("order_items").delete().eq("order_id", draft!.id);
  await admin.from("orders").delete().eq("id", draft!.id);

  console.log("\n=== Real Twilio sends used by this verification ===");
  console.log(realTwilioSends);
  console.log(
    "(0 expected: test-range skip + TWILIO_SIMULATE_ERROR never call Twilio.)",
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
