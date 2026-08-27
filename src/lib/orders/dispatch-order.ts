import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { ORDER_STATUS } from "@/lib/orders/status";
import { createAdminClient } from "@/lib/supabase/admin";

interface OrderRow {
  id: string;
  order_ref: string;
  business_id: string;
  customer_id: string;
  thread_id: string | null;
  status: string;
  dispatch_tracking_number: string | null;
  dispatch_carrier: string | null;
}

export type DispatchOrderOutcome =
  | {
      action: "dispatched";
      orderId: string;
      orderRef: string;
      outboundMessageId: string;
    }
  | { action: "already_dispatched"; orderId: string; orderRef: string }
  | { action: "invalid_status"; orderId: string; status: string };

export type DeliverOrderOutcome =
  | {
      action: "delivered";
      orderId: string;
      orderRef: string;
      outboundMessageId: string;
    }
  | { action: "already_delivered"; orderId: string; orderRef: string }
  | { action: "not_dispatched"; orderId: string; status: string }
  | { action: "invalid_status"; orderId: string; status: string };

async function formatItemLines(
  supabase: SupabaseClient,
  orderId: string,
): Promise<string[]> {
  const { data: items } = await supabase
    .from("order_items")
    .select(
      "quantity, product_variants(label, products(name))",
    )
    .eq("order_id", orderId);

  return (items ?? []).map((item) => {
    const raw = item.product_variants as unknown;
    const variant = (Array.isArray(raw) ? raw[0] : raw) as {
      label: string | null;
      products: { name: string } | { name: string }[] | null;
    } | null;
    const productRaw = variant?.products;
    const product = Array.isArray(productRaw) ? productRaw[0] : productRaw;
    const name = product?.name ?? "Item";
    const label = variant?.label ? ` (${variant.label})` : "";
    return `• ${item.quantity}× ${name}${label}`;
  });
}

async function sendBuyerUpdate(params: {
  order: OrderRow;
  text: string;
}): Promise<string> {
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("phone_e164")
    .eq("id", params.order.customer_id)
    .maybeSingle();

  if (!customer?.phone_e164) {
    throw new Error("Buyer phone number not found");
  }

  const sent = await sendWhatsAppMessage({
    businessId: params.order.business_id,
    toPhoneE164: customer.phone_e164,
    text: params.text,
    threadId: params.order.thread_id,
    customerId: params.order.customer_id,
    supabase: admin,
  });
  return sent.messageId;
}

function buildDispatchMessage(
  orderRef: string,
  itemLines: string[],
  trackingNumber?: string,
  carrier?: string,
): string {
  const lines = [`Your order ${orderRef} has been dispatched!`, "", ...itemLines];

  if (trackingNumber || carrier) {
    lines.push("");
    if (carrier) lines.push(`Carrier: ${carrier}`);
    if (trackingNumber) lines.push(`Tracking: ${trackingNumber}`);
    lines.push("", "It's on its way to you!");
  } else {
    lines.push("", "It's on its way to you!");
  }

  return lines.join("\n");
}

/**
 * Mark a PAID order DISPATCHED and notify the buyer.
 * Idempotent — safe to call more than once.
 */
export async function dispatchOrder(
  supabase: SupabaseClient,
  orderId: string,
  options?: { trackingNumber?: string; carrier?: string },
): Promise<DispatchOrderOutcome> {
  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, order_ref, business_id, customer_id, thread_id, status, dispatch_tracking_number, dispatch_carrier",
    )
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!order) {
    throw new Error("ORDER_NOT_FOUND");
  }

  const row = order as OrderRow;

  if (row.status === ORDER_STATUS.DISPATCHED) {
    return {
      action: "already_dispatched",
      orderId,
      orderRef: row.order_ref,
    };
  }
  if (row.status === ORDER_STATUS.DELIVERED) {
    return {
      action: "already_dispatched",
      orderId,
      orderRef: row.order_ref,
    };
  }
  if (row.status !== ORDER_STATUS.PAID) {
    return { action: "invalid_status", orderId, status: row.status };
  }

  const trackingNumber = options?.trackingNumber?.trim() || null;
  const carrier = options?.carrier?.trim() || null;

  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({
      status: ORDER_STATUS.DISPATCHED,
      dispatch_tracking_number: trackingNumber,
      dispatch_carrier: carrier,
    })
    .eq("id", orderId)
    .eq("status", ORDER_STATUS.PAID)
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (!updated) {
    const { data: current } = await supabase
      .from("orders")
      .select("status, order_ref")
      .eq("id", orderId)
      .maybeSingle();
    if (current?.status === ORDER_STATUS.DISPATCHED) {
      return {
        action: "already_dispatched",
        orderId,
        orderRef: current.order_ref as string,
      };
    }
    return {
      action: "invalid_status",
      orderId,
      status: current?.status ?? "unknown",
    };
  }

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: row.business_id,
    from_status: ORDER_STATUS.PAID,
    to_status: ORDER_STATUS.DISPATCHED,
  });

  const itemLines = await formatItemLines(supabase, orderId);
  const message = buildDispatchMessage(
    row.order_ref,
    itemLines,
    trackingNumber ?? undefined,
    carrier ?? undefined,
  );
  const outboundMessageId = await sendBuyerUpdate({ order: row, text: message });

  return {
    action: "dispatched",
    orderId,
    orderRef: row.order_ref,
    outboundMessageId,
  };
}

/**
 * Mark a DISPATCHED order DELIVERED and notify the buyer.
 * Rejects PAID orders that were never dispatched.
 */
export async function deliverOrder(
  supabase: SupabaseClient,
  orderId: string,
): Promise<DeliverOrderOutcome> {
  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, order_ref, business_id, customer_id, thread_id, status",
    )
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!order) {
    throw new Error("ORDER_NOT_FOUND");
  }

  const row = order as OrderRow;

  if (row.status === ORDER_STATUS.DELIVERED) {
    return {
      action: "already_delivered",
      orderId,
      orderRef: row.order_ref,
    };
  }
  if (row.status === ORDER_STATUS.PAID) {
    return { action: "not_dispatched", orderId, status: row.status };
  }
  if (row.status !== ORDER_STATUS.DISPATCHED) {
    return { action: "invalid_status", orderId, status: row.status };
  }

  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({ status: ORDER_STATUS.DELIVERED })
    .eq("id", orderId)
    .eq("status", ORDER_STATUS.DISPATCHED)
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (!updated) {
    const { data: current } = await supabase
      .from("orders")
      .select("status, order_ref")
      .eq("id", orderId)
      .maybeSingle();
    if (current?.status === ORDER_STATUS.DELIVERED) {
      return {
        action: "already_delivered",
        orderId,
        orderRef: current.order_ref as string,
      };
    }
    if (current?.status === ORDER_STATUS.PAID) {
      return { action: "not_dispatched", orderId, status: current.status };
    }
    return {
      action: "invalid_status",
      orderId,
      status: current?.status ?? "unknown",
    };
  }

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: row.business_id,
    from_status: ORDER_STATUS.DISPATCHED,
    to_status: ORDER_STATUS.DELIVERED,
  });

  const itemLines = await formatItemLines(supabase, orderId);
  const message = [
    `Your order ${row.order_ref} has been delivered!`,
    "",
    ...itemLines,
    "",
    "Enjoy — thanks for shopping with us!",
  ].join("\n");

  const outboundMessageId = await sendBuyerUpdate({ order: row, text: message });

  return {
    action: "delivered",
    orderId,
    orderRef: row.order_ref,
    outboundMessageId,
  };
}

/** Exposed for tests — exact message builder. */
export { buildDispatchMessage };
