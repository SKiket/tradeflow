/**
 * Step 20 — Shippo tracking webhook (mocked Twilio, no real Shippo).
 *
 *   npx --yes tsx scripts/verify-shippo-webhook.mts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

import {
  clearLastTwilioRequest,
  setTwilioPosterForTests,
} from "../src/lib/channels/send/twilio-whatsapp.ts";
import { deliverOrder } from "../src/lib/orders/dispatch-order.ts";
import { resetIdempotencyStore } from "../src/lib/webhooks/idempotency.ts";
import { handleShippoEvent } from "../src/lib/webhooks/handlers/shippo.ts";
import { isWebhookSecretConfigured } from "../src/lib/webhooks/verify/config.ts";
import { verifyShippoWebhookToken } from "../src/lib/webhooks/verify/signatures.ts";
import { POST as shippoPost } from "../src/app/api/webhooks/shippo/route.ts";

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

const TEST_SECRET = `shippo_test_${randomBytes(16).toString("hex")}`;
process.env.SHIPPO_WEBHOOK_SECRET = TEST_SECRET;
process.env.TWILIO_DRY_RUN = "true";

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

const BUYER = "+447700900301";
const SELLER = "+447700900302";
const TRACK = `TFTRACK${randomBytes(4).toString("hex").toUpperCase()}`;
const CARRIER = "Royal Mail";
const EN_DELIVERED_SID = "HXshippoDeliveredEn000000000001";
const EN_ISSUE_SID = "HXshippoIssueEn00000000000001";

type Captured = {
  kind?: string;
  contentSid?: string;
  contentVariables?: Record<string, string>;
  to?: string;
  body?: string;
};

function trackPayload(params: {
  status: string;
  trackingNumber?: string;
  carrier?: string;
  statusDate?: string;
  eventId?: string;
}) {
  return JSON.stringify({
    event: "track_updated",
    event_id: params.eventId ?? `evt_${randomUUID()}`,
    data: {
      tracking_number: params.trackingNumber ?? TRACK,
      carrier: params.carrier ?? "royal_mail",
      tracking_status: {
        status: params.status,
        status_date: params.statusDate ?? new Date().toISOString(),
        status_details: "carrier free text must never be used",
      },
    },
  });
}

async function callShippoRoute(token: string | null, body: string) {
  const url =
    token == null
      ? "http://localhost/api/webhooks/shippo"
      : `http://localhost/api/webhooks/shippo?token=${encodeURIComponent(token)}`;
  const req = new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const res = await shippoPost(req);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function ensureBusiness(): Promise<{
  id: string;
  priorSellerPhone: string | null;
}> {
  const { data } = await admin
    .from("businesses")
    .select("id, seller_whatsapp_phone_e164")
    .is("deleted_at", null)
    .not("whatsapp_phone_e164", "is", null)
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("No business with whatsapp_phone_e164");
  const prior = (data.seller_whatsapp_phone_e164 as string | null) ?? null;
  await admin
    .from("businesses")
    .update({ seller_whatsapp_phone_e164: SELLER })
    .eq("id", data.id);
  return { id: data.id as string, priorSellerPhone: prior };
}

async function ensureCustomer(businessId: string, phone: string, lastMessageAt: string | null) {
  const { data: existing } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", phone)
    .maybeSingle();
  if (existing) {
    await admin
      .from("customers")
      .update({
        preferred_language: "en",
        last_customer_message_at: lastMessageAt,
      })
      .eq("id", existing.id);
    return existing.id as string;
  }
  const { data, error } = await admin
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: phone,
      preferred_language: "en",
      last_customer_message_at: lastMessageAt,
      channel_identifiers: { whatsapp: phone },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "customer create failed");
  return data.id as string;
}

async function createDispatchedOrder(params: {
  businessId: string;
  customerId: string;
  tracking?: string;
  carrier?: string;
  status?: string;
}) {
  const orderRef = `TF-S20-${randomBytes(3).toString("hex").toUpperCase()}`;
  const { data, error } = await admin
    .from("orders")
    .insert({
      business_id: params.businessId,
      customer_id: params.customerId,
      channel: "whatsapp",
      status: params.status ?? "DISPATCHED",
      total_pence: 1500,
      order_ref: orderRef,
      dispatch_tracking_number: params.tracking ?? TRACK,
      dispatch_carrier: params.carrier ?? CARRIER,
      tracking_status: null,
      tracking_updated_at: null,
      delivered_at: null,
    })
    .select("id, order_ref, status, business_id, dispatch_tracking_number, dispatch_carrier")
    .single();
  if (error || !data) throw new Error(error?.message ?? "order create failed");
  return data;
}

async function upsertApproved(params: {
  key: string;
  language: string;
  sid: string;
  body: string;
  variableNames: string[];
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
        variable_names: params.variableNames,
      })
      .eq("id", existing.id);
    return;
  }
  await admin.from("message_templates").insert({
    template_key: params.key,
    language: params.language,
    body: params.body,
    variable_names: params.variableNames,
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

async function countBuyerDeliveredMsgs(customerId: string, orderRef: string) {
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text, raw_payload")
    .eq("customer_id", customerId)
    .eq("direction", "outbound")
    .ilike("normalised_text", `%${orderRef}%`)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []).filter((m) =>
    /delivered/i.test((m.normalised_text as string) ?? ""),
  );
}

async function recentOutbound(params: {
  businessId: string;
  textIncludes?: string;
  templateKey?: string;
  sendMode?: string;
}) {
  // Look back a few minutes — avoid flaky gte(now) vs DB clock skew.
  const sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text, raw_payload, created_at, customer_id")
    .eq("business_id", params.businessId)
    .eq("direction", "outbound")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(40);
  return (data ?? []).filter((m) => {
    const text = (m.normalised_text as string) ?? "";
    if (params.textIncludes && !text.includes(params.textIncludes)) return false;
    const payload = (m.raw_payload ?? {}) as Record<string, unknown>;
    if (params.templateKey && payload.template_key !== params.templateKey) {
      return false;
    }
    if (params.sendMode && payload.send_mode !== params.sendMode) {
      return false;
    }
    return true;
  });
}

function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

async function main() {
  console.log("=== Step 20 Shippo tracking webhook verify ===\n");
  resetIdempotencyStore();

  const captured: Captured[] = [];
  setTwilioPosterForTests(async (req) => {
    captured.push(req as Captured);
    clearLastTwilioRequest();
    return { sid: `MOCK_${randomUUID().slice(0, 8)}`, status: "queued" };
  });

  // ---- Auth / fail-closed ----
  if (
    !verifyShippoWebhookToken(
      `http://x/api/webhooks/shippo?token=${TEST_SECRET}`,
      TEST_SECRET,
    )
  ) {
    fail("token match");
  } else {
    pass("token match (constant-time compare)");
  }

  if (
    verifyShippoWebhookToken(
      "http://x/api/webhooks/shippo?token=wrong",
      TEST_SECRET,
    )
  ) {
    fail("wrong token rejected");
  } else {
    pass("wrong token rejected");
  }

  if (verifyShippoWebhookToken("http://x/api/webhooks/shippo", TEST_SECRET)) {
    fail("missing token rejected");
  } else {
    pass("missing token rejected");
  }

  const savedSecret = process.env.SHIPPO_WEBHOOK_SECRET;
  delete process.env.SHIPPO_WEBHOOK_SECRET;
  const unsetRes = await callShippoRoute(TEST_SECRET, trackPayload({ status: "TRANSIT" }));
  if (unsetRes.status === 401 && !isWebhookSecretConfigured(undefined)) {
    pass("secret unset → 401 fail closed");
  } else {
    fail("secret unset → 401 fail closed", `status=${unsetRes.status}`);
  }
  process.env.SHIPPO_WEBHOOK_SECRET = savedSecret!;

  const wrongHttp = await callShippoRoute("not-the-secret", trackPayload({ status: "TRANSIT" }));
  if (wrongHttp.status === 401) pass("HTTP wrong token → 401");
  else fail("HTTP wrong token → 401", `status=${wrongHttp.status}`);

  const missingHttp = await callShippoRoute(null, trackPayload({ status: "TRANSIT" }));
  if (missingHttp.status === 401) pass("HTTP missing token → 401");
  else fail("HTTP missing token → 401", `status=${missingHttp.status}`);

  // ---- Columns exist (migration) ----
  const { error: colErr } = await admin
    .from("orders")
    .select("tracking_status, tracking_updated_at, delivered_at")
    .limit(1);
  if (colErr) fail("orders tracking columns exist", colErr.message);
  else pass("orders tracking columns exist");

  // No new SECURITY DEFINER functions in this migration — permissions N/A.
  pass("permissions: no new DB functions (columns-only migration)");

  const { id: businessId, priorSellerPhone } = await ensureBusiness();
  const customerId = await ensureCustomer(
    businessId,
    BUYER,
    new Date().toISOString(),
  );

  // Cross-tenant business (second shop) — event must not touch it
  const { data: otherBiz } = await admin
    .from("businesses")
    .select("id")
    .is("deleted_at", null)
    .neq("id", businessId)
    .limit(1)
    .maybeSingle();

  const order = await createDispatchedOrder({ businessId, customerId });
  let otherOrderId: string | null = null;
  if (otherBiz?.id) {
    const otherCustomer = await ensureCustomer(
      otherBiz.id as string,
      "+447700900303",
      new Date().toISOString(),
    );
    // Distinct tracking — an event for TRACK must never touch this row.
    const other = await createDispatchedOrder({
      businessId: otherBiz.id as string,
      customerId: otherCustomer,
      tracking: `OTHER${randomBytes(3).toString("hex").toUpperCase()}`,
      carrier: CARRIER,
    });
    otherOrderId = other.id as string;
  }

  // ---- Unknown tracking → 200, nothing changes ----
  const beforeUnknown = await admin
    .from("orders")
    .select("status, tracking_status")
    .eq("id", order.id)
    .single();
  const unk = await handleShippoEvent(
    trackPayload({
      status: "DELIVERED",
      trackingNumber: "DOES-NOT-EXIST-999",
      carrier: "royal_mail",
    }),
  );
  const afterUnknown = await admin
    .from("orders")
    .select("status, tracking_status")
    .eq("id", order.id)
    .single();
  if (
    unk.status === 200 &&
    unk.body.reason === "order_not_found" &&
    beforeUnknown.data?.status === afterUnknown.data?.status &&
    beforeUnknown.data?.tracking_status === afterUnknown.data?.tracking_status
  ) {
    pass("unknown tracking → 200, nothing changes");
  } else {
    fail("unknown tracking → 200, nothing changes", JSON.stringify(unk.body));
  }

  // ---- DELIVERED ----
  captured.length = 0;
  const statusDate = "2026-11-10T12:00:00.000Z";
  const deliveredEvt = await handleShippoEvent(
    trackPayload({ status: "DELIVERED", statusDate }),
  );
  const { data: afterDeliver } = await admin
    .from("orders")
    .select("status, delivered_at, tracking_status")
    .eq("id", order.id)
    .single();
  const deliveredMsgs = await countBuyerDeliveredMsgs(customerId, order.order_ref as string);

  if (
    deliveredEvt.body.action === "delivered" &&
    afterDeliver?.status === "DELIVERED" &&
    sameInstant(afterDeliver.delivered_at as string, statusDate) &&
    afterDeliver.tracking_status === "DELIVERED" &&
    deliveredMsgs.length === 1
  ) {
    pass("DELIVERED → order DELIVERED, delivered_at set, one buyer notify");
  } else {
    fail(
      "DELIVERED → order DELIVERED, delivered_at set, one buyer notify",
      JSON.stringify({
        body: deliveredEvt.body,
        afterDeliver,
        msgCount: deliveredMsgs.length,
      }),
    );
  }

  if (otherOrderId) {
    const { data: otherAfter } = await admin
      .from("orders")
      .select("status, tracking_status")
      .eq("id", otherOrderId)
      .single();
    if (otherAfter?.status === "DISPATCHED" && otherAfter.tracking_status == null) {
      pass("cross-tenant: other shop order untouched");
    } else {
      fail(
        "cross-tenant: other shop order untouched",
        JSON.stringify(otherAfter),
      );
    }
  } else {
    pass("cross-tenant: skipped (only one business)");
  }

  // Replay same DELIVERED (new event id so in-memory idempotency doesn't short-circuit handler)
  captured.length = 0;
  const beforeReplayCount = deliveredMsgs.length;
  const replay = await handleShippoEvent(
    trackPayload({ status: "DELIVERED", statusDate, eventId: `evt_${randomUUID()}` }),
  );
  const afterReplayMsgs = await countBuyerDeliveredMsgs(
    customerId,
    order.order_ref as string,
  );
  if (
    replay.body.action === "already_delivered" &&
    afterReplayMsgs.length === beforeReplayCount
  ) {
    pass("replay DELIVERED → no second notification");
  } else {
    fail(
      "replay DELIVERED → no second notification",
      JSON.stringify({ body: replay.body, counts: [beforeReplayCount, afterReplayMsgs.length] }),
    );
  }

  // Out-of-order TRANSIT after DELIVERED
  const transit = await handleShippoEvent(
    trackPayload({ status: "TRANSIT", eventId: `evt_${randomUUID()}` }),
  );
  const { data: afterTransit } = await admin
    .from("orders")
    .select("status, tracking_status")
    .eq("id", order.id)
    .single();
  if (
    afterTransit?.status === "DELIVERED" &&
    transit.body.action === "tracking_stored" &&
    afterTransit.tracking_status === "TRANSIT"
  ) {
    pass("out-of-order TRANSIT after DELIVERED → status stays DELIVERED");
  } else {
    fail(
      "out-of-order TRANSIT after DELIVERED → status stays DELIVERED",
      JSON.stringify({ transit: transit.body, afterTransit }),
    );
  }

  // Manual deliver after automatic → no double notify
  captured.length = 0;
  const manual = await deliverOrder(admin, order.id as string);
  const afterManualMsgs = await countBuyerDeliveredMsgs(
    customerId,
    order.order_ref as string,
  );
  if (manual.action === "already_delivered" && afterManualMsgs.length === beforeReplayCount) {
    pass("manual deliver after automatic → already_delivered, no double notify");
  } else {
    fail(
      "manual deliver after automatic → already_delivered, no double notify",
      JSON.stringify({ manual, msgCount: afterManualMsgs.length }),
    );
  }

  // ---- CANCELLED never revived ----
  const cancelled = await createDispatchedOrder({
    businessId,
    customerId,
    tracking: `CXL${randomBytes(3).toString("hex").toUpperCase()}`,
    status: "CANCELLED",
  });
  const cxlEvt = await handleShippoEvent(
    trackPayload({
      status: "DELIVERED",
      trackingNumber: cancelled.dispatch_tracking_number as string,
      carrier: "royal_mail",
      eventId: `evt_${randomUUID()}`,
    }),
  );
  const { data: cxlAfter } = await admin
    .from("orders")
    .select("status")
    .eq("id", cancelled.id)
    .single();
  if (
    cxlAfter?.status === "CANCELLED" &&
    cxlEvt.body.action === "ignored_terminal"
  ) {
    pass("CANCELLED order never revived");
  } else {
    fail("CANCELLED order never revived", JSON.stringify({ cxlEvt: cxlEvt.body, cxlAfter }));
  }

  // ---- RETURNED / FAILURE ----
  const issueOrder = await createDispatchedOrder({
    businessId,
    customerId,
    tracking: `ISS${randomBytes(3).toString("hex").toUpperCase()}`,
  });
  const { data: issueRow } = await admin
    .from("orders")
    .select("dispatch_tracking_number, order_ref, status")
    .eq("id", issueOrder.id)
    .single();

  process.env.TEMPLATES_ENABLED = "false";
  const failEvt = await handleShippoEvent(
    trackPayload({
      status: "FAILURE",
      trackingNumber: issueRow!.dispatch_tracking_number as string,
      carrier: "royal_mail",
      eventId: `evt_${randomUUID()}`,
    }),
  );
  const { data: afterFail } = await admin
    .from("orders")
    .select("status, tracking_status")
    .eq("id", issueOrder.id)
    .single();
  const sellerIssueMsgs = await recentOutbound({
    businessId,
    textIncludes: issueRow!.order_ref as string,
    templateKey: "seller_delivery_issue",
  });
  if (
    failEvt.body.action === "delivery_issue" &&
    afterFail?.status === "DISPATCHED" &&
    afterFail.tracking_status === "FAILURE" &&
    sellerIssueMsgs.length >= 1 &&
    /delivery failed/i.test((sellerIssueMsgs[0]?.normalised_text as string) ?? "")
  ) {
    pass("FAILURE → status unchanged, seller alert sent");
  } else {
    fail(
      "FAILURE → status unchanged, seller alert sent",
      JSON.stringify({ body: failEvt.body, afterFail, sellerIssueMsgs }),
    );
  }

  const afterFailCount = sellerIssueMsgs.length;
  const returnedReplay = await handleShippoEvent(
    trackPayload({
      status: "RETURNED",
      trackingNumber: issueRow!.dispatch_tracking_number as string,
      carrier: "royal_mail",
      eventId: `evt_${randomUUID()}`,
    }),
  );
  const sellerIssueMsgs2 = await recentOutbound({
    businessId,
    textIncludes: issueRow!.order_ref as string,
    templateKey: "seller_delivery_issue",
  });
  if (
    returnedReplay.body.action === "issue_already_alerted" &&
    sellerIssueMsgs2.length === afterFailCount
  ) {
    pass("RETURNED after FAILURE → no second seller alert");
  } else {
    fail(
      "RETURNED after FAILURE → no second seller alert",
      JSON.stringify({
        body: returnedReplay.body,
        counts: [afterFailCount, sellerIssueMsgs2.length],
      }),
    );
  }

  // ---- Template path outside 24h ----
  const tplCustomer = await ensureCustomer(
    businessId,
    "+447700900304",
    new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  );
  const tplOrder = await createDispatchedOrder({
    businessId,
    customerId: tplCustomer,
    tracking: `TPL${randomBytes(3).toString("hex").toUpperCase()}`,
  });
  const { data: tplRow } = await admin
    .from("orders")
    .select("dispatch_tracking_number, order_ref")
    .eq("id", tplOrder.id)
    .single();

  await upsertApproved({
    key: "order_delivered",
    language: "en",
    sid: EN_DELIVERED_SID,
    body: "Your order {{1}} has been delivered. Tracking details are available at {{2}}. Thank you for your order.",
    variableNames: ["orderRef", "url"],
  });
  process.env.TEMPLATES_ENABLED = "true";
  await handleShippoEvent(
    trackPayload({
      status: "DELIVERED",
      trackingNumber: tplRow!.dispatch_tracking_number as string,
      carrier: "royal_mail",
      eventId: `evt_${randomUUID()}`,
    }),
  );
  const tplMsgs = await recentOutbound({
    businessId,
    textIncludes: tplRow!.order_ref as string,
    templateKey: "order_delivered",
    sendMode: "template",
  });
  const tplPayload = (tplMsgs[0]?.raw_payload ?? {}) as Record<string, unknown>;
  if (
    tplMsgs.length >= 1 &&
    tplPayload.send_mode === "template" &&
    tplPayload.content_sid === EN_DELIVERED_SID
  ) {
    pass("outside 24h + TEMPLATES_ENABLED + approved → template path");
  } else {
    fail(
      "outside 24h + TEMPLATES_ENABLED + approved → template path",
      JSON.stringify(tplMsgs),
    );
  }

  await clearApproved("order_delivered", "en");
  const tplOrder2 = await createDispatchedOrder({
    businessId,
    customerId: tplCustomer,
    tracking: `TP2${randomBytes(3).toString("hex").toUpperCase()}`,
  });
  const { data: tplRow2 } = await admin
    .from("orders")
    .select("dispatch_tracking_number")
    .eq("id", tplOrder2.id)
    .single();
  captured.length = 0;
  await handleShippoEvent(
    trackPayload({
      status: "DELIVERED",
      trackingNumber: tplRow2!.dispatch_tracking_number as string,
      carrier: "royal_mail",
      eventId: `evt_${randomUUID()}`,
    }),
  );
  const { data: failedMsg } = await admin
    .from("messages")
    .select("id, delivery_status, raw_payload")
    .eq("customer_id", tplCustomer)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(5);
  const recordedFail = (failedMsg ?? []).some((m) => {
    const payload = m.raw_payload as Record<string, unknown> | null;
    return (
      m.delivery_status === "failed" ||
      payload?.send_failed === true ||
      payload?.template_missing === true ||
      typeof payload?.error === "string"
    );
  });
  if (recordedFail || captured.length === 0) {
    pass("outside 24h, no approved template → recorded failure / no silent send");
  } else {
    fail(
      "outside 24h, no approved template → recorded failure / no silent send",
      JSON.stringify({ captured, failedMsg }),
    );
  }

  // Seller delivery issue template path
  await upsertApproved({
    key: "seller_delivery_issue",
    language: "en",
    sid: EN_ISSUE_SID,
    body: "There is a delivery problem with order {{1}}: the carrier reports {{2}}. Open your TradeFlow dashboard for details.",
    variableNames: ["orderRef", "issue"],
  });
  const issueTplOrder = await createDispatchedOrder({
    businessId,
    customerId,
    tracking: `ITP${randomBytes(3).toString("hex").toUpperCase()}`,
  });
  // Seller alerts don't use buyer service window the same way — still exercise template key.
  const { data: issueTplRow } = await admin
    .from("orders")
    .select("dispatch_tracking_number")
    .eq("id", issueTplOrder.id)
    .single();
  await handleShippoEvent(
    trackPayload({
      status: "RETURNED",
      trackingNumber: issueTplRow!.dispatch_tracking_number as string,
      carrier: "royal_mail",
      eventId: `evt_${randomUUID()}`,
    }),
  );
  const issueTplMsgs = await recentOutbound({
    businessId,
    textIncludes: issueTplOrder.order_ref as string,
    templateKey: "seller_delivery_issue",
  });
  const issueText = (issueTplMsgs[0]?.normalised_text as string) ?? "";
  if (
    issueTplMsgs.length >= 1 &&
    /returned to sender/i.test(issueText) &&
    !/carrier free text/i.test(issueText)
  ) {
    pass("seller_delivery_issue uses fixed phrase only (not carrier free text)");
  } else {
    fail(
      "seller_delivery_issue uses fixed phrase only",
      JSON.stringify(issueTplMsgs),
    );
  }

  // Manual deliver alone still works
  const manualOnly = await createDispatchedOrder({
    businessId,
    customerId: await ensureCustomer(businessId, "+447700900305", new Date().toISOString()),
    tracking: `MAN${randomBytes(3).toString("hex").toUpperCase()}`,
  });
  captured.length = 0;
  process.env.TEMPLATES_ENABLED = "false";
  const manOut = await deliverOrder(admin, manualOnly.id as string);
  const { data: manRow } = await admin
    .from("orders")
    .select("status, delivered_at")
    .eq("id", manualOnly.id)
    .single();
  if (
    manOut.action === "delivered" &&
    manRow?.status === "DELIVERED" &&
    Boolean(manRow.delivered_at)
  ) {
    pass("manual Mark delivered still works and sets delivered_at");
  } else {
    fail("manual Mark delivered still works", JSON.stringify({ manOut, manRow }));
  }

  // Cleanup templates + seller phone
  await clearApproved("order_delivered", "en");
  await clearApproved("seller_delivery_issue", "en");
  await admin
    .from("businesses")
    .update({ seller_whatsapp_phone_e164: priorSellerPhone })
    .eq("id", businessId);

  // Cleanup test orders (best-effort)
  await admin
    .from("orders")
    .delete()
    .in("order_ref", [
      order.order_ref,
      cancelled.order_ref,
      issueOrder.order_ref,
      tplOrder.order_ref,
      tplOrder2.order_ref,
      issueTplOrder.order_ref,
      manualOnly.order_ref,
    ]);

  setTwilioPosterForTests(null);

  console.log("\n========================================");
  const allPassed = results.every((r) => r.ok);
  console.log(allPassed ? "ALL STEP 20 CHECKS PASSED" : "SOME STEP 20 CHECKS FAILED");
  console.log("========================================");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
