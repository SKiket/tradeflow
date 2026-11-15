import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ORDER_STATUS } from "@/lib/orders/status";
import {
  extractTwilioSids,
  redactTwilioMessageResources,
  type TwilioRedactCounts,
} from "@/lib/privacy/twilio-redact";

/** Orders that must be settled before buyer erasure. */
export const ERASURE_BLOCKING_STATUSES: readonly string[] = [
  ORDER_STATUS.PENDING_CONFIRMATION,
  ORDER_STATUS.AWAITING_PAYMENT,
  ORDER_STATUS.PAID,
  ORDER_STATUS.REFUND_PENDING,
  ORDER_STATUS.RETURN_REQUESTED,
  ORDER_STATUS.RETURN_APPROVED,
];

export type EraseCustomerCounts = {
  messagesDeleted: number;
  pendingReplaysDeleted: number;
  ordersAnonymised: number;
  refundReasonsCleared: number;
  customerAnonymised: number;
  twilio: TwilioRedactCounts;
};

export type EraseCustomerResult =
  | {
      ok: true;
      alreadyErased: boolean;
      customerId: string;
      businessId: string;
      counts: EraseCustomerCounts;
      deletionRequestId: string | null;
    }
  | {
      ok: false;
      blocked: true;
      reason: string;
      blockingOrderRefs: string[];
    }
  | {
      ok: false;
      blocked: false;
      error: string;
    };

function emptyTwilio(): TwilioRedactCounts {
  return {
    messagesAttempted: 0,
    messagesDeleted: 0,
    mediaAttempted: 0,
    mediaDeleted: 0,
    failures: 0,
  };
}

function emptyCounts(): EraseCustomerCounts {
  return {
    messagesDeleted: 0,
    pendingReplaysDeleted: 0,
    ordersAnonymised: 0,
    refundReasonsCleared: 0,
    customerAnonymised: 0,
    twilio: emptyTwilio(),
  };
}

function mergeTwilio(
  a: TwilioRedactCounts,
  b: TwilioRedactCounts,
): TwilioRedactCounts {
  return {
    messagesAttempted: a.messagesAttempted + b.messagesAttempted,
    messagesDeleted: a.messagesDeleted + b.messagesDeleted,
    mediaAttempted: a.mediaAttempted + b.mediaAttempted,
    mediaDeleted: a.mediaDeleted + b.mediaDeleted,
    failures: a.failures + b.failures,
  };
}

export async function findErasureBlocks(
  supabase: SupabaseClient,
  businessId: string,
  customerId: string,
): Promise<{ blocked: boolean; reason: string; orderRefs: string[] }> {
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, order_ref, status")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .is("deleted_at", null);

  if (error) {
    return { blocked: true, reason: error.message, orderRefs: [] };
  }

  const blocking = (orders ?? []).filter((o) =>
    ERASURE_BLOCKING_STATUSES.includes(o.status as string),
  );
  if (blocking.length > 0) {
    return {
      blocked: true,
      reason:
        "Customer has an unpaid, unfulfilled, or open refund/return order. Finish or cancel it before erasing.",
      orderRefs: blocking.map((o) => o.order_ref as string),
    };
  }

  const orderIds = (orders ?? []).map((o) => o.id as string);
  if (orderIds.length > 0) {
    const { data: pendingRefunds, error: refundError } = await supabase
      .from("order_refunds")
      .select("id, order_id")
      .eq("business_id", businessId)
      .eq("status", "pending")
      .in("order_id", orderIds);
    if (refundError) {
      return { blocked: true, reason: refundError.message, orderRefs: [] };
    }
    if ((pendingRefunds ?? []).length > 0) {
      const refs = (orders ?? [])
        .filter((o) =>
          (pendingRefunds ?? []).some((r) => r.order_id === o.id),
        )
        .map((o) => o.order_ref as string);
      return {
        blocked: true,
        reason: "A Stripe refund is still pending for this customer.",
        orderRefs: refs,
      };
    }
  }

  // Stripe disputes are not tracked in TradeFlow — see Step 19 report.
  return { blocked: false, reason: "", orderRefs: [] };
}

export async function canEraseCustomer(
  supabase: SupabaseClient,
  businessId: string,
  customerId: string,
): Promise<{ ok: true } | { ok: false; reason: string; orderRefs: string[] }> {
  const blocks = await findErasureBlocks(supabase, businessId, customerId);
  if (blocks.blocked) {
    return { ok: false, reason: blocks.reason, orderRefs: blocks.orderRefs };
  }
  return { ok: true };
}

/**
 * Erase / anonymise one buyer for a shop. Idempotent.
 * Prefer service-role client so pending_replays + hard deletes always succeed;
 * callers must verify the customer belongs to the business first.
 */
export async function eraseCustomer(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    customerId: string;
    requestedBy: "seller" | "operator";
    recordRequest?: boolean;
  },
): Promise<EraseCustomerResult> {
  const { businessId, customerId, requestedBy } = params;
  const recordRequest = params.recordRequest !== false;
  const counts = emptyCounts();

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, business_id, name, phone_e164, deleted_at")
    .eq("id", customerId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (customerError) {
    return { ok: false, blocked: false, error: customerError.message };
  }
  if (!customer) {
    return {
      ok: true,
      alreadyErased: true,
      customerId,
      businessId,
      counts,
      deletionRequestId: null,
    };
  }

  const alreadyErased =
    Boolean(customer.deleted_at) &&
    (customer.name as string | null) === "Deleted customer";

  if (!alreadyErased) {
    const blocks = await findErasureBlocks(supabase, businessId, customerId);
    if (blocks.blocked) {
      if (recordRequest) {
        await supabase.from("deletion_requests").insert({
          business_id: businessId,
          subject_type: "customer",
          subject_id: customerId,
          requested_by: requestedBy,
          status: "blocked",
          counts: { order_refs_count: blocks.orderRefs.length },
        });
      }
      return {
        ok: false,
        blocked: true,
        reason: blocks.reason,
        blockingOrderRefs: blocks.orderRefs,
      };
    }
  }

  const { data: messages } = await supabase
    .from("messages")
    .select("id, raw_payload, media_urls")
    .eq("business_id", businessId)
    .eq("customer_id", customerId);

  for (const message of messages ?? []) {
    const hasTwilio =
      extractTwilioSids(message.raw_payload).messageSid ||
      (Array.isArray(message.media_urls) && message.media_urls.length > 0);
    if (hasTwilio) {
      const twilio = await redactTwilioMessageResources({
        rawPayload: message.raw_payload,
      });
      counts.twilio = mergeTwilio(counts.twilio, twilio);
    }
  }

  const { count: replayCount } = await supabase
    .from("pending_replays")
    .delete({ count: "exact" })
    .eq("business_id", businessId)
    .eq("customer_id", customerId);
  counts.pendingReplaysDeleted = replayCount ?? 0;

  const { count: msgCount } = await supabase
    .from("messages")
    .delete({ count: "exact" })
    .eq("business_id", businessId)
    .eq("customer_id", customerId);
  counts.messagesDeleted = msgCount ?? 0;

  const { data: orders } = await supabase
    .from("orders")
    .select("id")
    .eq("business_id", businessId)
    .eq("customer_id", customerId);

  const orderIds = (orders ?? []).map((o) => o.id as string);

  if (orderIds.length > 0) {
    const { count: refundCount, error: refundClearError } = await supabase
      .from("order_refunds")
      .update({ reason: null }, { count: "exact" })
      .eq("business_id", businessId)
      .in("order_id", orderIds)
      .not("reason", "is", null);
    if (refundClearError) {
      return { ok: false, blocked: false, error: refundClearError.message };
    }
    counts.refundReasonsCleared = refundCount ?? 0;

    const { count: orderCount, error: orderAnonError } = await supabase
      .from("orders")
      .update(
        {
          notes: null,
          shipping_address: null,
          return_reason: null,
          return_reason_detail: null,
          return_notes: null,
          anonymised_at: new Date().toISOString(),
        },
        { count: "exact" },
      )
      .eq("business_id", businessId)
      .eq("customer_id", customerId);
    if (orderAnonError) {
      return { ok: false, blocked: false, error: orderAnonError.message };
    }
    counts.ordersAnonymised = orderCount ?? orderIds.length;
  }

  const placeholderPhone = `deleted-${randomUUID()}`;
  const { error: anonError } = await supabase
    .from("customers")
    .update({
      name: "Deleted customer",
      phone_e164: placeholderPhone,
      channel_identifiers: {},
      addresses: [],
      notes: null,
      tags: [],
      broadcast_opt_in: false,
      preferred_language: null,
      deleted_at: new Date().toISOString(),
    })
    .eq("id", customerId)
    .eq("business_id", businessId);

  if (anonError) {
    return { ok: false, blocked: false, error: anonError.message };
  }
  counts.customerAnonymised = 1;

  let deletionRequestId: string | null = null;
  if (recordRequest) {
    const { data: reqRow } = await supabase
      .from("deletion_requests")
      .insert({
        business_id: businessId,
        subject_type: "customer",
        subject_id: customerId,
        requested_by: requestedBy,
        status: "completed",
        completed_at: new Date().toISOString(),
        counts: {
          messages_deleted: counts.messagesDeleted,
          pending_replays_deleted: counts.pendingReplaysDeleted,
          orders_anonymised: counts.ordersAnonymised,
          refund_reasons_cleared: counts.refundReasonsCleared,
          customer_anonymised: counts.customerAnonymised,
          twilio_messages_deleted: counts.twilio.messagesDeleted,
          twilio_media_deleted: counts.twilio.mediaDeleted,
          twilio_failures: counts.twilio.failures,
          reapply: alreadyErased,
        },
      })
      .select("id")
      .maybeSingle();
    deletionRequestId = (reqRow?.id as string | undefined) ?? null;
  }

  return {
    ok: true,
    alreadyErased,
    customerId,
    businessId,
    counts,
    deletionRequestId,
  };
}
