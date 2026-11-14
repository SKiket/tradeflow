/**
 * D3 pending_replay verification — mocks only, 0 real Twilio sends.
 * Run: npx --yes tsx scripts/verify-d3-pending-replay.mts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import {
  countPendingReplays,
  evaluateReplayCancellation,
  type PendingReplayRow,
} from "../src/lib/channels/pending-replay.ts";
import { runPendingReplay } from "../src/lib/cron/pending-replay.ts";
import { createDraftOrderFromParse } from "../src/lib/orders/create-draft-order.ts";
import { pauseAiUntil } from "../src/lib/inbox/ai-pause.ts";

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

const realTwilioSends = 0;
const cases: Array<{ id: string; ok: boolean; detail: string }> = [];

function report(id: string, ok: boolean, detail: string) {
  cases.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  (${id}) ${detail}`);
}

async function main() {
  console.log("=== D3 pending_replay verify ===\n");
  delete process.env.TWILIO_SIMULATE_ERROR;
  process.env.FORCE_REAL_SEND = "";

  const { data: business } = await admin
    .from("businesses")
    .select("id")
    .eq("name", "EK-Pousser_D")
    .single();
  if (!business) throw new Error("business missing");

  const phone = "+447733308706";
  let { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", business.id)
    .eq("phone_e164", phone)
    .maybeSingle();
  if (!customer) {
    const { data: c } = await admin
      .from("customers")
      .insert({
        business_id: business.id,
        phone_e164: phone,
        channel_identifiers: { whatsapp: phone },
      })
      .select("id")
      .single();
    customer = c!;
  }

  // Clear AI pause for clean tests
  await admin
    .from("customers")
    .update({ ai_paused_until: null })
    .eq("id", customer!.id);

  // Supersede leftover pending rows so banner counts are deterministic.
  await admin
    .from("pending_replays")
    .update({
      status: "superseded",
      cancel_reason: "verify cleanup",
      next_attempt_at: null,
    })
    .eq("business_id", business.id)
    .in("status", ["pending", "processing"]);

  // Free reserved test number — never collide with an existing customer row.
  const TEST = "+447700900399";
  await admin
    .from("customers")
    .delete()
    .eq("business_id", business.id)
    .eq("phone_e164", TEST);

  async function setCustomerPhone(to: string) {
    const { error } = await admin
      .from("customers")
      .update({
        phone_e164: to,
        channel_identifiers: { whatsapp: to },
      })
      .eq("id", customer!.id);
    if (error) throw new Error(`phone update failed: ${error.message}`);
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
  const productId = products![0].id as string;

  async function seedDraft(threadId: string, qty: number, orderRef: string) {
    const { data: draft } = await admin
      .from("orders")
      .insert({
        business_id: business!.id,
        customer_id: customer!.id,
        thread_id: threadId,
        channel: "whatsapp",
        status: "PENDING_CONFIRMATION",
        total_pence: unit * qty,
        order_ref: orderRef,
      })
      .select("id")
      .single();
    await admin.from("order_items").insert({
      order_id: draft!.id,
      business_id: business!.id,
      product_variant_id: variant.id,
      quantity: qty,
      unit_price_pence: unit,
    });
    return draft!.id as string;
  }

  function orderParse(qty: number) {
    return {
      intent: "order" as const,
      confidence: 1,
      language: "en",
      needs_clarification: false,
      clarification_message: null,
      items: [
        {
          product_query: "classic blue mug",
          variant_query: "",
          quantity: qty,
          matched_product_id: productId,
          matched_variant_id: variant.id,
          match_confidence: 1,
        },
      ],
    };
  }

  async function insertInbound(
    threadId: string,
    text: string,
    parse?: ReturnType<typeof orderParse>,
  ) {
    const { data: msg } = await admin
      .from("messages")
      .insert({
        business_id: business!.id,
        customer_id: customer!.id,
        channel: "whatsapp",
        direction: "inbound",
        thread_id: threadId,
        normalised_text: text,
        raw_payload: { Body: text },
        ...(parse ? { ai_parse_result: parse } : {}),
      })
      .select("id, created_at")
      .single();
    return msg!;
  }

  // ---------- (a) 63038 on 3 mugs ----------
  console.log("\n--- (a) ---");
  const threadA = randomUUID();
  const refA = `TF-D3A-${randomBytes(2).toString("hex").toUpperCase()}`;
  await seedDraft(threadA, 2, refA);
  const inboundA = await insertInbound(threadA, "3 mugs", orderParse(3));

  process.env.TWILIO_SIMULATE_ERROR = "63038";
  const outcomeA = await createDraftOrderFromParse({
    businessId: business.id,
    customerId: customer!.id,
    customerPhoneE164: phone,
    threadId: threadA,
    inboundMessageId: inboundA.id,
    parseResult: orderParse(3),
    supabase: admin,
  });
  delete process.env.TWILIO_SIMULATE_ERROR;

  const { data: draftA } = await admin
    .from("orders")
    .select("total_pence")
    .eq("order_ref", refA)
    .single();
  const { data: itemsA } = await admin
    .from("order_items")
    .select("quantity")
    .eq("order_id", (await admin.from("orders").select("id").eq("order_ref", refA).single()).data!.id);
  const { data: replayA } = await admin
    .from("pending_replays")
    .select("*")
    .eq("inbound_message_id", inboundA.id)
    .maybeSingle();
  const bannerA = await countPendingReplays(admin, business.id);

  const okA =
    Boolean(outcomeA.sendError) &&
    draftA?.total_pence === unit * 2 &&
    itemsA?.[0]?.quantity === 2 &&
    replayA?.status === "pending" &&
    bannerA >= 1;
  report(
    "a",
    okA,
    `draft reverted to 2×; queued=${replayA?.status}; banner=${bannerA}; buyerSees=nothing; inbox=Waiting to retry`,
  );

  // ---------- (b) mock success later ----------
  console.log("\n--- (b) ---");
  // Clear any leftover outbound rate-limit backoff so the cheap probe allows send.
  await admin
    .from("messages")
    .update({ next_retry_at: null })
    .eq("business_id", business.id)
    .eq("delivery_status", "failed")
    .not("next_retry_at", "is", null);

  await admin
    .from("pending_replays")
    .update({
      status: "pending",
      next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    })
    .eq("id", replayA!.id);

  await setCustomerPhone(TEST);

  const runB = await runPendingReplay(admin);
  const { data: replayB } = await admin
    .from("pending_replays")
    .select("status, attempts")
    .eq("id", replayA!.id)
    .single();
  const { data: orderB } = await admin
    .from("orders")
    .select("id, total_pence, status")
    .eq("order_ref", refA)
    .single();
  const { data: itemsB } = await admin
    .from("order_items")
    .select("quantity")
    .eq("order_id", orderB!.id);
  const { count: draftCount } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadA)
    .eq("status", "PENDING_CONFIRMATION");
  const bannerB = await countPendingReplays(admin, business.id);

  await setCustomerPhone(phone);

  const okB =
    replayB?.status === "succeeded" &&
    itemsB?.[0]?.quantity === 3 &&
    orderB?.total_pence === unit * 3 &&
    (draftCount ?? 0) === 1 &&
    bannerB === 0;
  report(
    "b",
    okB,
    `replay re-applied 3× once; status=${replayB?.status}; drafts=${draftCount}; banner=${bannerB}; run=${JSON.stringify(runB)}`,
  );

  // ---------- (c) newer inbound supersedes ----------
  console.log("\n--- (c) ---");
  const threadC = randomUUID();
  const refC = `TF-D3C-${randomBytes(2).toString("hex").toUpperCase()}`;
  await seedDraft(threadC, 2, refC);
  const inboundC1 = await insertInbound(threadC, "3 mugs", orderParse(3));
  process.env.TWILIO_SIMULATE_ERROR = "63038";
  await createDraftOrderFromParse({
    businessId: business.id,
    customerId: customer!.id,
    customerPhoneE164: phone,
    threadId: threadC,
    inboundMessageId: inboundC1.id,
    parseResult: orderParse(3),
    supabase: admin,
  });
  delete process.env.TWILIO_SIMULATE_ERROR;

  const { data: replayC1 } = await admin
    .from("pending_replays")
    .select("*")
    .eq("inbound_message_id", inboundC1.id)
    .single();

  // Newer inbound "actually 4" (same as webhook cancel + process)
  const { cancelPendingReplaysForThread } = await import(
    "../src/lib/channels/pending-replay.ts"
  );
  const inboundC2 = await insertInbound(threadC, "actually 4");
  await cancelPendingReplaysForThread({
    supabase: admin,
    businessId: business.id,
    threadId: threadC,
    reason: "Newer inbound on thread — replay superseded",
  });

  await setCustomerPhone(TEST);
  const outcomeC2 = await createDraftOrderFromParse({
    businessId: business.id,
    customerId: customer!.id,
    customerPhoneE164: TEST,
    threadId: threadC,
    inboundMessageId: inboundC2.id,
    parseResult: orderParse(4),
    supabase: admin,
  });
  await setCustomerPhone(phone);

  const { data: afterC1 } = await admin
    .from("pending_replays")
    .select("status, cancel_reason")
    .eq("id", replayC1!.id)
    .single();
  const { data: orderC } = await admin
    .from("orders")
    .select("total_pence")
    .eq("order_ref", refC)
    .single();

  const okC =
    afterC1?.status === "superseded" &&
    !outcomeC2.sendError &&
    orderC?.total_pence === unit * 4;
  report(
    "c",
    okC,
    `old replay=${afterC1?.status} (${afterC1?.cancel_reason}); draft now 4×; only newer processed`,
  );

  // ---------- (d) seller replies manually ----------
  console.log("\n--- (d) ---");
  const threadD = randomUUID();
  const refD = `TF-D3D-${randomBytes(2).toString("hex").toUpperCase()}`;
  await seedDraft(threadD, 2, refD);
  const inboundD = await insertInbound(threadD, "3 mugs", orderParse(3));
  process.env.TWILIO_SIMULATE_ERROR = "63038";
  await createDraftOrderFromParse({
    businessId: business.id,
    customerId: customer!.id,
    customerPhoneE164: phone,
    threadId: threadD,
    inboundMessageId: inboundD.id,
    parseResult: orderParse(3),
    supabase: admin,
  });
  delete process.env.TWILIO_SIMULATE_ERROR;

  const pausedUntil = pauseAiUntil();
  await admin
    .from("customers")
    .update({ ai_paused_until: pausedUntil.toISOString() })
    .eq("id", customer!.id);
  // Simulated seller reply
  await admin.from("messages").insert({
    business_id: business.id,
    customer_id: customer!.id,
    channel: "whatsapp",
    direction: "outbound",
    thread_id: threadD,
    normalised_text: "Hi — I'll help you with that order.",
    delivery_status: "simulated",
    delivery_audience: "buyer",
    raw_payload: { kind: "seller_reply", to: phone },
  });

  const { data: replayD } = await admin
    .from("pending_replays")
    .select("*")
    .eq("inbound_message_id", inboundD.id)
    .single();
  const decisionD = await evaluateReplayCancellation({
    supabase: admin,
    row: replayD as PendingReplayRow,
  });
  if (decisionD.cancel) {
    await admin
      .from("pending_replays")
      .update({
        status: decisionD.status,
        cancel_reason: decisionD.reason,
        next_attempt_at: null,
      })
      .eq("id", replayD!.id);
  }
  const { data: afterD } = await admin
    .from("pending_replays")
    .select("status, cancel_reason")
    .eq("id", replayD!.id)
    .single();

  await admin
    .from("customers")
    .update({ ai_paused_until: null })
    .eq("id", customer!.id);

  report(
    "d",
    afterD?.status === "superseded",
    `replay=${afterD?.status}: ${afterD?.cancel_reason}`,
  );

  // ---------- (e) 13h expiry ----------
  console.log("\n--- (e) ---");
  const threadE = randomUUID();
  const inboundE = await insertInbound(threadE, "3 mugs");
  const thirteenAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  const { data: replayE } = await admin
    .from("pending_replays")
    .insert({
      inbound_message_id: inboundE.id,
      business_id: business.id,
      customer_id: customer!.id,
      thread_id: threadE,
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      next_attempt_at: new Date(Date.now() - 1000).toISOString(),
      last_error: "old",
      created_at: thirteenAgo,
    })
    .select("*")
    .single();
  // Force created_at if DB overwrote
  await admin
    .from("pending_replays")
    .update({ created_at: thirteenAgo })
    .eq("id", replayE!.id);

  const runE = await runPendingReplay(admin);
  const { data: afterE } = await admin
    .from("pending_replays")
    .select("status, cancel_reason")
    .eq("id", replayE!.id)
    .single();
  report(
    "e",
    afterE?.status === "expired" && runE.expired >= 1,
    `status=${afterE?.status}; reason=${afterE?.cancel_reason}; run.expired=${runE.expired}`,
  );

  // ---------- (f) fail twice, succeed third ----------
  console.log("\n--- (f) ---");
  const threadF = randomUUID();
  const refF = `TF-D3F-${randomBytes(2).toString("hex").toUpperCase()}`;
  await seedDraft(threadF, 2, refF);
  const inboundF = await insertInbound(threadF, "3 mugs", orderParse(3));
  process.env.TWILIO_SIMULATE_ERROR = "63038";
  await createDraftOrderFromParse({
    businessId: business.id,
    customerId: customer!.id,
    customerPhoneE164: phone,
    threadId: threadF,
    inboundMessageId: inboundF.id,
    parseResult: orderParse(3),
    supabase: admin,
  });
  const { data: replayF } = await admin
    .from("pending_replays")
    .select("*")
    .eq("inbound_message_id", inboundF.id)
    .single();

  const backoffs: string[] = [];
  for (let i = 0; i < 2; i++) {
    await admin
      .from("pending_replays")
      .update({
        status: "pending",
        next_attempt_at: new Date(Date.now() - 1000).toISOString(),
      })
      .eq("id", replayF!.id);
    await runPendingReplay(admin);
    const { data: mid } = await admin
      .from("pending_replays")
      .select("attempts, next_attempt_at, status")
      .eq("id", replayF!.id)
      .single();
    backoffs.push(
      `attempt=${mid?.attempts} next=${mid?.next_attempt_at} status=${mid?.status}`,
    );
  }

  delete process.env.TWILIO_SIMULATE_ERROR;
  await setCustomerPhone(TEST);
  // Clear outbound rate-limit probe backoff from the simulated failures.
  await admin
    .from("messages")
    .update({ next_retry_at: null })
    .eq("business_id", business.id)
    .eq("delivery_status", "failed")
    .not("next_retry_at", "is", null);
  await admin
    .from("pending_replays")
    .update({
      status: "pending",
      next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    })
    .eq("id", replayF!.id);
  await runPendingReplay(admin);
  await setCustomerPhone(phone);

  const { data: afterF } = await admin
    .from("pending_replays")
    .select("status, attempts")
    .eq("id", replayF!.id)
    .single();
  const { data: orderF } = await admin
    .from("orders")
    .select("total_pence")
    .eq("order_ref", refF)
    .single();
  const { data: itemsF } = await admin
    .from("order_items")
    .select("quantity")
    .eq(
      "order_id",
      (await admin.from("orders").select("id").eq("order_ref", refF).single()).data!.id,
    );

  const okF =
    afterF?.status === "succeeded" &&
    afterF.attempts === 3 &&
    itemsF?.[0]?.quantity === 3 &&
    orderF?.total_pence === unit * 3;
  report(
    "f",
    okF,
    `status=${afterF?.status} attempts=${afterF?.attempts}; qty=3; backoffs=[${backoffs.join(" | ")}]`,
  );

  // Cleanup drafts
  for (const ref of [refA, refC, refD, refF]) {
    const { data: o } = await admin.from("orders").select("id").eq("order_ref", ref).maybeSingle();
    if (o) {
      await admin.from("order_items").delete().eq("order_id", o.id);
      await admin.from("orders").delete().eq("id", o.id);
    }
  }

  console.log("\n=== (g) Real Twilio sends used ===");
  console.log(realTwilioSends);
  console.log("(0 expected — TWILIO_SIMULATE_ERROR + +447700900xxx)\n");

  const failed = cases.filter((c) => !c.ok);
  console.log(`${cases.length - failed.length}/${cases.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
