import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { t } from "@/lib/i18n";
import { buyerFacingReturnReasonLabel } from "@/lib/i18n/buyer-reason";
import { getCustomerPreferredLanguage } from "@/lib/i18n/language";
import { statusLabel } from "@/lib/orders/display";
import {
  parseReturnReason,
  RETURN_REASON_LABEL,
  type ReturnReason,
} from "@/lib/orders/return-reasons";
import {
  isWithinReturnWindow,
  parseReturnWindowDays,
} from "@/lib/orders/return-window";
import { ORDER_STATUS } from "@/lib/orders/status";
import {
  notifySellerOfAutoApprovedReturn,
  notifySellerOfReturnRequest,
} from "@/lib/support/notify-seller";
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

export function buyerReturnApprovedMessage(
  orderRef: string,
  lang?: string | null,
): string {
  return t("return.approved", lang, {
    orderRef,
    slipUrl: returnSlipUrl(orderRef),
  });
}

export function buyerReturnRequestedMessage(params: {
  orderRef: string;
  reason: ReturnReason;
  detail?: string | null;
  lang?: string | null;
}): string {
  return t("return.requested", params.lang, {
    orderRef: params.orderRef,
    reason: buyerFacingReturnReasonLabel(
      params.reason,
      params.detail,
      params.lang,
    ),
  });
}

export function buyerReturnNotDeliveredMessage(params: {
  orderRef?: string | null;
  status?: string | null;
  lang?: string | null;
}): string {
  if (params.orderRef && params.status) {
    return t("return.not_delivered_with_status", params.lang, {
      orderRef: params.orderRef,
      status: statusLabel(params.status).toLowerCase(),
    });
  }
  return t("return.not_delivered", params.lang);
}

export function buyerReturnAlreadyMessage(params: {
  orderRef: string;
  status: string;
  lang?: string | null;
}): string {
  switch (params.status) {
    case ORDER_STATUS.RETURN_REQUESTED:
      return t("return.already_requested", params.lang, {
        orderRef: params.orderRef,
      });
    case ORDER_STATUS.RETURN_APPROVED:
      return t("return.already_approved", params.lang, {
        orderRef: params.orderRef,
      });
    case ORDER_STATUS.RETURN_DECLINED:
      return t("return.declined", params.lang, {
        orderRef: params.orderRef,
      });
    case ORDER_STATUS.RETURNED:
      return t("return.already_returned", params.lang, {
        orderRef: params.orderRef,
      });
    default:
      return t("return.already_started", params.lang, {
        orderRef: params.orderRef,
      });
  }
}

export function buyerReturnWhichOrderMessage(
  orderRefs: string[],
  lang?: string | null,
): string {
  return t("return.which_order", lang, {
    orderRefs: orderRefs.join(", "),
  });
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
  | {
      action: "auto_approved";
      orderId: string;
      orderRef: string;
      reason: ReturnReason;
      detail: string | null;
      slipUrl: string;
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

  const autoApprove = await shouldAutoApproveCoolingOff(supabase, {
    orderId,
    businessId: row.business_id,
    reason: parsed,
  });

  const now = new Date().toISOString();
  const nextStatus = autoApprove
    ? ORDER_STATUS.RETURN_APPROVED
    : ORDER_STATUS.RETURN_REQUESTED;

  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({
      status: nextStatus,
      return_reason: parsed,
      return_reason_detail: detailText,
      return_requested_at: now,
      return_decided_at: autoApprove ? now : null,
      return_auto_approved: autoApprove,
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
    to_status: nextStatus,
  });

  if (autoApprove) {
    await notifySellerOfAutoApprovedReturn({
      businessId: row.business_id,
      orderRef: row.order_ref,
      supabase,
    });
    const lang = await getCustomerPreferredLanguage(supabase, row.customer_id);
    const slip = returnSlipUrl(row.order_ref);
    await sendBuyerWhatsApp({
      businessId: row.business_id,
      customerId: row.customer_id,
      threadId: row.thread_id,
      text: buyerReturnApprovedMessage(row.order_ref, lang),
      template: {
        key: "return_approved",
        variables: {
          orderRef: row.order_ref,
          url: slip,
        },
      },
    });
    return {
      action: "auto_approved",
      orderId: row.id,
      orderRef: row.order_ref,
      reason: parsed,
      detail: detailText,
      slipUrl: slip,
    };
  }

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
  const lang = await getCustomerPreferredLanguage(
    supabase,
    order.customer_id as string,
  );
  const text =
    decision === "approve"
      ? buyerReturnApprovedMessage(order.order_ref as string, lang)
      : await declineBuyerMessage(
          supabase,
          order.business_id as string,
          order.order_ref as string,
          order.customer_id as string,
        );

  await sendBuyerWhatsApp({
    businessId: order.business_id as string,
    customerId: order.customer_id as string,
    threadId: (order.thread_id as string | null) ?? null,
    text,
    template:
      decision === "approve"
        ? {
            key: "return_approved",
            variables: {
              orderRef: order.order_ref as string,
              url: slipUrl,
            },
          }
        : {
            key: "return_declined",
            variables: {
              orderRef: order.order_ref as string,
            },
          },
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

export type MarkReturnedOptions = {
  /** When true (default), restock tracked variants. When false, leave stock unchanged. */
  restock?: boolean;
};

export type MarkReturnedOutcome =
  | {
      action: "returned";
      orderId: string;
      orderRef: string;
      restocked: boolean | null;
    }
  | { action: "invalid_status"; orderId: string; status: string }
  | { action: "not_found" };

export async function markReturned(
  supabase: SupabaseClient,
  orderId: string,
  options: MarkReturnedOptions = {},
): Promise<MarkReturnedOutcome> {
  const wantRestock = options.restock !== false;

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, order_ref, business_id, status, return_restocked")
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!order) return { action: "not_found" };

  // Idempotent: already RETURNED → never restock again.
  if (order.status === ORDER_STATUS.RETURNED) {
    return {
      action: "returned",
      orderId,
      orderRef: order.order_ref as string,
      restocked:
        typeof order.return_restocked === "boolean"
          ? order.return_restocked
          : null,
    };
  }
  if (order.status !== ORDER_STATUS.RETURN_APPROVED) {
    return {
      action: "invalid_status",
      orderId,
      status: order.status as string,
    };
  }

  const { data: lines } = await supabase
    .from("order_items")
    .select("quantity, product_variant_id, product_variants(track_inventory)")
    .eq("order_id", orderId)
    .eq("business_id", order.business_id as string);

  const trackedLines: { variantId: string; qty: number }[] = [];
  for (const line of lines ?? []) {
    const variantId = line.product_variant_id as string | null;
    const qty = (line.quantity as number) ?? 0;
    if (!variantId || qty <= 0) continue;
    const variantRaw = line.product_variants as
      | { track_inventory: boolean | null }
      | { track_inventory: boolean | null }[]
      | null;
    const variant = Array.isArray(variantRaw) ? (variantRaw[0] ?? null) : variantRaw;
    if (!variant?.track_inventory) continue;
    trackedLines.push({ variantId, qty });
  }

  const hasTracked = trackedLines.length > 0;
  const returnRestocked: boolean | null = hasTracked ? wantRestock : null;

  // Atomic gate: UPDATE … WHERE status = RETURN_APPROVED. Only the first
  // writer wins; losers must not restock or overwrite return_restocked.
  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({
      status: ORDER_STATUS.RETURNED,
      return_restocked: returnRestocked,
    })
    .eq("id", orderId)
    .eq("status", ORDER_STATUS.RETURN_APPROVED)
    .select("id, return_restocked")
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    // Race: another request already transitioned — re-read, never restock twice.
    const { data: again } = await supabase
      .from("orders")
      .select("status, order_ref, return_restocked")
      .eq("id", orderId)
      .maybeSingle();
    if (again?.status === ORDER_STATUS.RETURNED) {
      return {
        action: "returned",
        orderId,
        orderRef: (again.order_ref as string) ?? (order.order_ref as string),
        restocked:
          typeof again.return_restocked === "boolean"
            ? again.return_restocked
            : null,
      };
    }
    return {
      action: "invalid_status",
      orderId,
      status: (again?.status as string) ?? ORDER_STATUS.RETURN_APPROVED,
    };
  }

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: order.business_id,
    from_status: ORDER_STATUS.RETURN_APPROVED,
    to_status: ORDER_STATUS.RETURNED,
  });

  if (wantRestock && hasTracked) {
    for (const line of trackedLines) {
      const { data: variant } = await supabase
        .from("product_variants")
        .select("id, stock_quantity, track_inventory")
        .eq("id", line.variantId)
        .eq("business_id", order.business_id as string)
        .maybeSingle();
      if (!variant?.track_inventory) continue;
      const next = Math.max(0, (variant.stock_quantity as number) + line.qty);
      const { error: stockError } = await supabase.rpc("adjust_variant_stock", {
        p_variant_id: line.variantId,
        p_stock_quantity: next,
        p_reason: "restock_return",
        p_order_id: orderId,
      });
      if (stockError) throw new Error(stockError.message);
    }
  }

  return {
    action: "returned",
    orderId,
    orderRef: order.order_ref as string,
    restocked: returnRestocked,
  };
}

async function shouldAutoApproveCoolingOff(
  supabase: SupabaseClient,
  params: { orderId: string; businessId: string; reason: ReturnReason },
): Promise<boolean> {
  if (params.reason !== "changed_mind") return false;

  const [{ data: business }, { data: order }] = await Promise.all([
    supabase
      .from("businesses")
      .select("return_window_days")
      .eq("id", params.businessId)
      .maybeSingle(),
    supabase
      .from("orders")
      .select("delivered_at")
      .eq("id", params.orderId)
      .maybeSingle(),
  ]);

  let deliveredAtIso = (order?.delivered_at as string | null) ?? null;

  // Legacy fallback: rows delivered before orders.delivered_at existed.
  if (!deliveredAtIso) {
    const { data: delivered } = await supabase
      .from("order_status_history")
      .select("changed_at")
      .eq("order_id", params.orderId)
      .eq("to_status", ORDER_STATUS.DELIVERED)
      .order("changed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    deliveredAtIso = (delivered?.changed_at as string | null) ?? null;
  }

  if (!deliveredAtIso) return false;
  const windowDays = parseReturnWindowDays(business?.return_window_days);
  return isWithinReturnWindow(new Date(deliveredAtIso), windowDays);
}

async function declineBuyerMessage(
  supabase: SupabaseClient,
  businessId: string,
  orderRef: string,
  customerId: string,
): Promise<string> {
  const lang = await getCustomerPreferredLanguage(supabase, customerId);
  const { data } = await supabase
    .from("businesses")
    .select("returns_policy_text")
    .eq("id", businessId)
    .maybeSingle();
  const policy = (data?.returns_policy_text as string | null)?.trim();
  const lines = [t("return.not_approved", lang, { orderRef })];
  if (policy) {
    // Seller policy text is inserted unchanged — never translate.
    lines.push("", policy);
  }
  return lines.join("\n");
}

async function sendBuyerWhatsApp(params: {
  businessId: string;
  customerId: string;
  threadId: string | null;
  text: string;
  template?: { key: string; variables: Record<string, string> };
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
      template: params.template,
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
