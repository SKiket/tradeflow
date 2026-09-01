import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { statusLabel } from "@/lib/orders/display";
import {
  parseReturnReason,
  RETURN_REASON_LABEL,
  type ReturnReason,
} from "@/lib/orders/return-reasons";
import { ORDER_STATUS } from "@/lib/orders/status";
import { notifySellerOfReturnRequest } from "@/lib/support/notify-seller";
import { orderTrackingUrl } from "@/lib/storefront/url";
import { createAdminClient } from "@/lib/supabase/admin";

export {
  isReturnReason,
  parseReturnReason,
  RETURN_REASON_LABEL,
  RETURN_REASONS,
  type ReturnReason,
} from "@/lib/orders/return-reasons";

const OPEN_RETURN_STATUSES = new Set<string>([
  ORDER_STATUS.RETURN_REQUESTED,
  ORDER_STATUS.RETURN_APPROVED,
  ORDER_STATUS.RETURN_DECLINED,
  ORDER_STATUS.RETURNED,
]);

export function returnSlipUrl(orderRef: string): string {
  return `${orderTrackingUrl(orderRef)}/return-slip`;
}

export function buyerReturnRequestedMessage(params: {
  orderRef: string;
  reason: ReturnReason;
  detail?: string | null;
}): string {
  const label =
    params.reason === "other" && params.detail?.trim()
      ? params.detail.trim()
      : RETURN_REASON_LABEL[params.reason];
  return `Got it — return requested for order ${params.orderRef}, reason: ${label}. We'll let you know once the seller's reviewed it.`;
}

export function buyerReturnNotDeliveredMessage(params: {
  orderRef?: string | null;
  status?: string | null;
}): string {
  if (params.orderRef && params.status) {
    return `A return can only be requested after the order has been delivered. Order ${params.orderRef} is currently ${statusLabel(params.status).toLowerCase()}, so I can't start a return yet.`;
  }
  return "A return can only be requested after an order has been delivered. I can't start a return for you yet.";
}

export function buyerReturnAlreadyMessage(params: {
  orderRef: string;
  status: string;
}): string {
  switch (params.status) {
    case ORDER_STATUS.RETURN_REQUESTED:
      return `A return has already been requested for order ${params.orderRef}. The seller is still reviewing it.`;
    case ORDER_STATUS.RETURN_APPROVED:
      return `A return for order ${params.orderRef} has already been approved. Print your return slip from the tracking page to send it back.`;
    case ORDER_STATUS.RETURN_DECLINED:
      return `The return request for order ${params.orderRef} was declined.`;
    case ORDER_STATUS.RETURNED:
      return `Order ${params.orderRef} has already been marked as returned.`;
    default:
      return `A return has already been started for order ${params.orderRef}.`;
  }
}

export function buyerReturnWhichOrderMessage(orderRefs: string[]): string {
  return `Which order would you like to return? ${orderRefs.join(", ")}`;
}

export async function findCustomerOrderByRef(
  supabase: SupabaseClient,
  params: { businessId: string; customerId: string; orderRef: string },
): Promise<{ id: string; orderRef: string; status: string } | null> {
  const match = params.orderRef.toUpperCase().match(/TF-[A-Z0-9-]{4,48}/);
  const ref = match ? match[0] : params.orderRef.trim().toUpperCase();
  if (!ref) return null;

  const { data, error } = await supabase
    .from("orders")
    .select("id, order_ref, status")
    .eq("business_id", params.businessId)
    .eq("customer_id", params.customerId)
    .is("deleted_at", null)
    .eq("order_ref", ref)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: data.id as string,
    orderRef: data.order_ref as string,
    status: data.status as string,
  };
}

export async function listCustomerDeliveredOrders(
  supabase: SupabaseClient,
  params: { businessId: string; customerId: string },
): Promise<Array<{ id: string; orderRef: string; status: string }>> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_ref, status")
    .eq("business_id", params.businessId)
    .eq("customer_id", params.customerId)
    .eq("status", ORDER_STATUS.DELIVERED)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    orderRef: row.order_ref as string,
    status: row.status as string,
  }));
}

export async function requestReturnByOrderRef(
  supabase: SupabaseClient,
  orderRef: string,
  reason: ReturnReason | string,
  detail?: string | null,
): Promise<RequestReturnOutcome> {
  const trimmed = decodeURIComponent(orderRef).trim();
  const { data, error } = await supabase
    .from("orders")
    .select("id")
    .eq("order_ref", trimmed)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return { action: "not_found" };
  return requestReturn(supabase, data.id as string, reason, detail);
}

interface OrderRow {
  id: string;
  order_ref: string;
  business_id: string;
  customer_id: string;
  thread_id: string | null;
  status: string;
  return_reason: string | null;
}

export type RequestReturnOutcome =
  | {
      action: "requested";
      orderId: string;
      orderRef: string;
      reason: ReturnReason;
      detail: string | null;
    }
  | { action: "already_requested"; orderId: string; orderRef: string; status: string }
  | { action: "not_delivered"; orderId: string; orderRef: string; status: string }
  | { action: "invalid_reason" }
  | { action: "not_found" };

export async function requestReturn(
  supabase: SupabaseClient,
  orderId: string,
  reason: ReturnReason | string,
  detail?: string | null,
): Promise<RequestReturnOutcome> {
  const parsed = parseReturnReason(reason);
  if (!parsed) return { action: "invalid_reason" };

  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, order_ref, business_id, customer_id, thread_id, status, return_reason",
    )
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!order) return { action: "not_found" };

  const row = order as OrderRow;
  const detailText = detail?.trim() || null;

  if (OPEN_RETURN_STATUSES.has(row.status)) {
    return {
      action: "already_requested",
      orderId: row.id,
      orderRef: row.order_ref,
      status: row.status,
    };
  }

  if (row.status !== ORDER_STATUS.DELIVERED) {
    return {
      action: "not_delivered",
      orderId: row.id,
      orderRef: row.order_ref,
      status: row.status,
    };
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({
      status: ORDER_STATUS.RETURN_REQUESTED,
      return_reason: parsed,
      return_reason_detail: detailText,
      return_requested_at: now,
    })
    .eq("id", orderId)
    .eq("status", ORDER_STATUS.DELIVERED)
    .select("id")
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);

  if (!updated) {
    const { data: current } = await supabase
      .from("orders")
      .select("status, order_ref")
      .eq("id", orderId)
      .maybeSingle();
    if (current && OPEN_RETURN_STATUSES.has(current.status as string)) {
      return {
        action: "already_requested",
        orderId,
        orderRef: current.order_ref as string,
        status: current.status as string,
      };
    }
    return {
      action: "not_delivered",
      orderId,
      orderRef: (current?.order_ref as string) ?? row.order_ref,
      status: (current?.status as string) ?? row.status,
    };
  }

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: row.business_id,
    from_status: ORDER_STATUS.DELIVERED,
    to_status: ORDER_STATUS.RETURN_REQUESTED,
  });

  await notifySellerOfReturnRequest({
    businessId: row.business_id,
    orderRef: row.order_ref,
    reasonLabel: RETURN_REASON_LABEL[parsed],
    detail: detailText,
    supabase,
  });

  return {
    action: "requested",
    orderId: row.id,
    orderRef: row.order_ref,
    reason: parsed,
    detail: detailText,
  };
}

export type DecideReturnOutcome =
  | { action: "approved"; orderId: string; orderRef: string; slipUrl: string }
  | { action: "declined"; orderId: string; orderRef: string }
  | { action: "invalid_status"; orderId: string; status: string }
  | { action: "not_found" };

export async function decideReturn(
  supabase: SupabaseClient,
  orderId: string,
  decision: "approve" | "decline",
  notes?: string | null,
): Promise<DecideReturnOutcome> {
  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, order_ref, business_id, customer_id, thread_id, status",
    )
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!order) return { action: "not_found" };

  if (order.status !== ORDER_STATUS.RETURN_REQUESTED) {
    return {
      action: "invalid_status",
      orderId,
      status: order.status as string,
    };
  }

  const nextStatus =
    decision === "approve"
      ? ORDER_STATUS.RETURN_APPROVED
      : ORDER_STATUS.RETURN_DECLINED;
  const now = new Date().toISOString();
  const noteText = notes?.trim() || null;

  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({
      status: nextStatus,
      return_decided_at: now,
      return_notes: noteText,
    })
    .eq("id", orderId)
    .eq("status", ORDER_STATUS.RETURN_REQUESTED)
    .select("id")
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    return {
      action: "invalid_status",
      orderId,
      status: ORDER_STATUS.RETURN_REQUESTED,
    };
  }

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: order.business_id,
    from_status: ORDER_STATUS.RETURN_REQUESTED,
    to_status: nextStatus,
  });

  const slipUrl = returnSlipUrl(order.order_ref as string);
  const text =
    decision === "approve"
      ? [
          `Your return for order ${order.order_ref} has been approved.`,
          "",
          `Please print your return slip: ${slipUrl}`,
          "",
          "You're responsible for return postage — the slip has the return address.",
        ].join("\n")
      : await declineBuyerMessage(
          supabase,
          order.business_id as string,
          order.order_ref as string,
        );

  await sendBuyerWhatsApp({
    businessId: order.business_id as string,
    customerId: order.customer_id as string,
    threadId: (order.thread_id as string | null) ?? null,
    text,
  });

  return decision === "approve"
    ? {
        action: "approved",
        orderId,
        orderRef: order.order_ref as string,
        slipUrl,
      }
    : {
        action: "declined",
        orderId,
        orderRef: order.order_ref as string,
      };
}

export type MarkReturnedOutcome =
  | { action: "returned"; orderId: string; orderRef: string }
  | { action: "invalid_status"; orderId: string; status: string }
  | { action: "not_found" };

export async function markReturned(
  supabase: SupabaseClient,
  orderId: string,
): Promise<MarkReturnedOutcome> {
  const { data: order, error } = await supabase
    .from("orders")
    .select("id, order_ref, business_id, status")
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!order) return { action: "not_found" };

  if (order.status === ORDER_STATUS.RETURNED) {
    return {
      action: "returned",
      orderId,
      orderRef: order.order_ref as string,
    };
  }
  if (order.status !== ORDER_STATUS.RETURN_APPROVED) {
    return {
      action: "invalid_status",
      orderId,
      status: order.status as string,
    };
  }

  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({ status: ORDER_STATUS.RETURNED })
    .eq("id", orderId)
    .eq("status", ORDER_STATUS.RETURN_APPROVED)
    .select("id")
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    return {
      action: "invalid_status",
      orderId,
      status: ORDER_STATUS.RETURN_APPROVED,
    };
  }

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: order.business_id,
    from_status: ORDER_STATUS.RETURN_APPROVED,
    to_status: ORDER_STATUS.RETURNED,
  });

  return {
    action: "returned",
    orderId,
    orderRef: order.order_ref as string,
  };
}

async function declineBuyerMessage(
  supabase: SupabaseClient,
  businessId: string,
  orderRef: string,
): Promise<string> {
  const { data } = await supabase
    .from("businesses")
    .select("returns_policy_text")
    .eq("id", businessId)
    .maybeSingle();
  const policy = (data?.returns_policy_text as string | null)?.trim();
  const lines = [`Your return for order ${orderRef} wasn't approved.`];
  if (policy) {
    lines.push("", policy);
  }
  return lines.join("\n");
}

async function sendBuyerWhatsApp(params: {
  businessId: string;
  customerId: string;
  threadId: string | null;
  text: string;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("phone_e164")
    .eq("id", params.customerId)
    .maybeSingle();
  if (!customer?.phone_e164) {
    console.error("[returns] buyer WhatsApp skipped — no phone", {
      customerId: params.customerId,
    });
    return;
  }
  try {
    await sendWhatsAppMessage({
      businessId: params.businessId,
      toPhoneE164: customer.phone_e164,
      text: params.text,
      threadId: params.threadId ?? undefined,
      customerId: params.customerId,
      supabase: admin,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[returns] buyer WhatsApp failed", { message });
    await admin.from("messages").insert({
      business_id: params.businessId,
      customer_id: params.customerId,
      channel: "whatsapp",
      direction: "outbound",
      normalised_text: params.text,
      thread_id: params.threadId,
      raw_payload: { provider: "twilio", send_failed: true, error: message },
    });
  }
}
