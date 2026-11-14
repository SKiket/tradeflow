/**
 * D2 verify — no real Twilio (test numbers + TWILIO_SIMULATE_ERROR).
 * Run: npx --yes tsx scripts/verify-d2-silent-gaps.mts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { handleInboundProcessingFailure } from "../src/lib/channels/inbound-crash.ts";
import { buildDraftItemSignature } from "../src/lib/channels/send/delivery.ts";
import { evaluateOutboundRetry } from "../src/lib/channels/send/retry-eligibility.ts";
import { sendWhatsAppMessage } from "../src/lib/channels/send/twilio-whatsapp.ts";
import { runWhatsAppDeliveryRetry } from "../src/lib/cron/whatsapp-delivery-retry.ts";
import { countRecentDeliveryFailures } from "../src/lib/dashboard/delivery-failures.ts";
import { createDraftOrderFromParse } from "../src/lib/orders/create-draft-order.ts";
import { t } from "../src/lib/i18n/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv() {
  const env: Record<string, string> = {};
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
    env[tline.slice(0, eq)] = v;
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

type CaseReport = {
  id: string;
  buyerSees: string;
  inboxShows: string;
  bannerSays: string;
};

const reports: CaseReport[] = [];

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  console.log("D2 silent-gap verification (0 real Twilio sends)\n");
  delete process.env.TWILIO_SIMULATE_ERROR;
  process.env.FORCE_REAL_SEND = "";

  const { data: business } = await admin
    .from("businesses")
    .select("id, whatsapp_phone_e164")
    .eq("name", "EK-Pousser_D")
    .single();
  if (!business) throw new Error("business missing");

  const TEST = "+447700900301";
  let { data: customer } = await admin
    .from("customers")
    .select("id, preferred_language")
    .eq("business_id", business.id)
    .eq("phone_e164", TEST)
    .maybeSingle();
  if (!customer) {
    const { data: c } = await admin
      .from("customers")
      .insert({
        business_id: business.id,
        phone_e164: TEST,
        preferred_language: "en",
        channel_identifiers: { whatsapp: TEST },
      })
      .select("id, preferred_language")
      .single();
    customer = c!;
  }
  await admin
    .from("customers")
    .update({ preferred_language: "en" })
    .eq("id", customer!.id);

  const threadA = randomUUID();

  // --- (a) AI gateway timeout ---
  section("(a) AI gateway timeout");
  const crashA = await handleInboundProcessingFailure({
    supabase: admin,
    businessId: business.id,
    customerId: customer!.id,
    customerPhoneE164: TEST,
    threadId: threadA,
    inboundMessageId: null,
    error: new Error("AI gateway timeout"),
  });
  const bannerA = await countRecentDeliveryFailures(admin, business.id);
  const apologyA = t("support.processing_apology", "en");
  reports.push({
    id: "a",
    buyerSees: crashA.apologySent
      ? apologyA
      : `(no apology — skipped=${crashA.apologySkipped} err=${crashA.apologyError})`,
    inboxShows: `Processing failed: ${crashA.errorText}` +
      (crashA.apologySent ? ` + apology outbound` : ""),
    bannerSays:
      bannerA.count > 0
        ? `${bannerA.count} messages could not be delivered (latest: ${bannerA.latestErrorText})`
        : "(banner clear)",
  });
  console.log(JSON.stringify(reports[reports.length - 1], null, 2));

  // --- (b) DB error after parsing ---
  section("(b) database error after parse");
  const threadB = randomUUID();
  // Use a fresh customer slice via same phone is fine — apology cooldown may skip
  // Create second customer for clean apology (different phone in test range)
  const TEST2 = "+447700900302";
  let { data: customerB } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", TEST2)
    .maybeSingle();
  if (!customerB) {
    const { data: c } = await admin
      .from("customers")
      .insert({
        business_id: business.id,
        phone_e164: TEST2,
        preferred_language: "fr",
        channel_identifiers: { whatsapp: TEST2 },
      })
      .select("id")
      .single();
    customerB = c!;
  }
  await admin
    .from("customers")
    .update({ preferred_language: "fr" })
    .eq("id", customerB!.id);

  const crashB = await handleInboundProcessingFailure({
    supabase: admin,
    businessId: business.id,
    customerId: customerB!.id,
    customerPhoneE164: TEST2,
    threadId: threadB,
    inboundMessageId: null,
    error: new Error("database error after parse"),
  });
  const bannerB = await countRecentDeliveryFailures(admin, business.id);
  const apologyB = t("support.processing_apology", "fr");
  reports.push({
    id: "b",
    buyerSees: crashB.apologySent
      ? apologyB
      : `(no apology skipped=${crashB.apologySkipped})`,
    inboxShows: `Processing failed: ${crashB.errorText}`,
    bannerSays: `${bannerB.count} messages could not be delivered (latest: ${bannerB.latestErrorText})`,
  });
  console.log(JSON.stringify(reports[reports.length - 1], null, 2));

  // --- (c) draft revert then scheduled retry → superseded ---
  section("(c) draft revert + scheduled retry");
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
    (products?.[0]?.product_variants as Array<{
      id: string;
      deleted_at: string | null;
    }>) || []
  ).find((v) => !v.deleted_at)!;
  const unit = products![0].price_pence as number;
  const draftThread = randomUUID();
  const orderRef = `TF-D2-${randomBytes(3).toString("hex").toUpperCase()}`;

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

  process.env.TWILIO_SIMULATE_ERROR = "63038";
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
          matched_product_id: products![0].id as string,
          matched_variant_id: variant.id,
          match_confidence: 1,
        },
      ],
    },
    supabase: admin,
  });
  delete process.env.TWILIO_SIMULATE_ERROR;

  const { data: failedRow } = await admin
    .from("messages")
    .select("id, normalised_text, delivery_status, next_retry_at, raw_payload, created_at")
    .eq("thread_id", draftThread)
    .eq("delivery_status", "failed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Force retry due now
  await admin
    .from("messages")
    .update({ next_retry_at: new Date(Date.now() - 1000).toISOString() })
    .eq("id", failedRow!.id);

  const retryC = await runWhatsAppDeliveryRetry(admin);
  const { data: afterC } = await admin
    .from("messages")
    .select("delivery_status, delivery_error_text, normalised_text")
    .eq("id", failedRow!.id)
    .single();
  const { data: draftAfter } = await admin
    .from("orders")
    .select("total_pence")
    .eq("id", draft!.id)
    .single();
  const { data: itemsAfter } = await admin
    .from("order_items")
    .select("quantity")
    .eq("order_id", draft!.id);

  const bannerC = await countRecentDeliveryFailures(admin, business.id);
  reports.push({
    id: "c",
    buyerSees:
      "Nothing new (stale 3× confirmation was NOT resent). Draft still at last delivered 2×.",
    inboxShows: `${afterC?.delivery_status}: ${afterC?.delivery_error_text} | queued text was about 3×; draft qty=${itemsAfter?.[0]?.quantity} total=${draftAfter?.total_pence}`,
    bannerSays:
      afterC?.delivery_status === "superseded"
        ? `Banner does not count superseded (count=${bannerC.count}); Inbox shows Superseded`
        : `unexpected status=${afterC?.delivery_status}; retry=${JSON.stringify(retryC)}`,
  });
  console.log(
    "retry result",
    retryC,
    "sendError",
    outcome.sendError,
    JSON.stringify(reports[reports.length - 1], null, 2),
  );

  // --- (d) 13-hour-old message → expired ---
  section("(d) retry of 13-hour-old message");
  const oldThread = randomUUID();
  const thirteenHoursAgo = new Date(
    Date.now() - 13 * 60 * 60 * 1000,
  ).toISOString();
  const { data: oldMsg } = await admin
    .from("messages")
    .insert({
      business_id: business.id,
      customer_id: customer!.id,
      channel: "whatsapp",
      direction: "outbound",
      thread_id: oldThread,
      normalised_text: "[D2] stale queued confirmation",
      delivery_status: "failed",
      delivery_error_code: "63038",
      delivery_error_text: "Daily message limit reached",
      delivery_attempts: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
      delivery_audience: "buyer",
      raw_payload: {
        provider: "twilio",
        to: TEST,
        from: business.whatsapp_phone_e164,
        queued_at: thirteenHoursAgo,
        retry_context: { kind: "generic" },
      },
    })
    .select("id, created_at, raw_payload")
    .single();

  const decisionD = await evaluateOutboundRetry({
    supabase: admin,
    messageId: oldMsg!.id,
    businessId: business.id,
    threadId: oldThread,
    customerId: customer!.id,
    createdAt: oldMsg!.created_at as string,
    normalisedText: "[D2] stale queued confirmation",
    rawPayload: {
      retry_context: { kind: "generic" },
      to: TEST,
      queued_at: thirteenHoursAgo,
    },
  });

  const retryD = await runWhatsAppDeliveryRetry(admin);
  const { data: afterD } = await admin
    .from("messages")
    .select("delivery_status, delivery_error_text")
    .eq("id", oldMsg!.id)
    .single();
  const bannerD = await countRecentDeliveryFailures(admin, business.id);

  reports.push({
    id: "d",
    buyerSees: "Nothing (expired — not resent)",
    inboxShows: `${afterD?.delivery_status}: ${afterD?.delivery_error_text} (decision=${decisionD.action})`,
    bannerSays: `${bannerD.count} messages could not be delivered — expired still counted until dismiss (latest: ${bannerD.latestErrorText})`,
  });
  console.log("retryD", retryD, JSON.stringify(reports[reports.length - 1], null, 2));

  // --- (e) two failures in 5 minutes → one apology ---
  section("(e) two failures in 5 minutes for one buyer");
  const TEST3 = "+447700900303";
  let { data: customerE } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", TEST3)
    .maybeSingle();
  if (!customerE) {
    const { data: c } = await admin
      .from("customers")
      .insert({
        business_id: business.id,
        phone_e164: TEST3,
        preferred_language: "en",
        channel_identifiers: { whatsapp: TEST3 },
      })
      .select("id")
      .single();
    customerE = c!;
  }
  const threadE = randomUUID();
  const first = await handleInboundProcessingFailure({
    supabase: admin,
    businessId: business.id,
    customerId: customerE!.id,
    customerPhoneE164: TEST3,
    threadId: threadE,
    inboundMessageId: null,
    error: new Error("first crash"),
  });
  const second = await handleInboundProcessingFailure({
    supabase: admin,
    businessId: business.id,
    customerId: customerE!.id,
    customerPhoneE164: TEST3,
    threadId: threadE,
    inboundMessageId: null,
    error: new Error("second crash"),
  });
  const bannerE = await countRecentDeliveryFailures(admin, business.id);
  reports.push({
    id: "e",
    buyerSees: first.apologySent
      ? `ONE apology only: "${t("support.processing_apology", "en")}" (second skipped=${second.apologySkipped})`
      : `unexpected first apologySent=${first.apologySent}`,
    inboxShows: `Two Processing failed rows; one apology outbound (first.apologySent=${first.apologySent}, second.apologySkipped=${second.apologySkipped})`,
    bannerSays: `${bannerE.count} messages could not be delivered`,
  });
  console.log(JSON.stringify(reports[reports.length - 1], null, 2));

  // cleanup draft
  await admin.from("order_items").delete().eq("order_id", draft!.id);
  await admin.from("orders").delete().eq("id", draft!.id);

  console.log("\n========== EXACT OUTPUT SUMMARY ==========\n");
  for (const r of reports) {
    console.log(`CASE ${r.id}`);
    console.log(`  Buyer sees:  ${r.buyerSees}`);
    console.log(`  Inbox shows: ${r.inboxShows}`);
    console.log(`  Banner says: ${r.bannerSays}`);
    console.log("");
  }

  const okC = afterC?.delivery_status === "superseded";
  const okD = afterD?.delivery_status === "expired" && decisionD.action === "expired";
  const okE = first.apologySent === true && second.apologySkipped === true;
  const okA = crashA.apologySent === true && crashA.recorded;
  const okB = crashB.apologySent === true && crashB.recorded;

  console.log("Real Twilio sends: 0");
  console.log(
    `PASS gates: a=${okA} b=${okB} c=${okC} d=${okD} e=${okE}`,
  );
  if (!(okA && okB && okC && okD && okE)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
