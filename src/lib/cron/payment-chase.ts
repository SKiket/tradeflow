import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import {
  cancelAwaitingPaymentOrder,
  PAYMENT_CHASE_AUTO_CANCEL_MESSAGE,
} from "@/lib/orders/confirm-draft-order";
import { ORDER_STATUS } from "@/lib/orders/status";
import { getOpenCheckoutUrl } from "@/lib/stripe/checkout";

const MS_PER_HOUR = 60 * 60 * 1000;
export const REMINDER_12H_MS = 12 * MS_PER_HOUR;
export const REMINDER_23H_MS = 23 * MS_PER_HOUR;
export const AUTO_CANCEL_MS = 24 * MS_PER_HOUR;

type ReminderColumn =
  | "payment_reminder_12h_sent_at"
  | "payment_reminder_23h_sent_at";

interface ChaseOrder {
  id: string;
  business_id: string;
  customer_id: string | null;
  thread_id: string | null;
  order_ref: string;
  stripe_checkout_session_id: string | null;
  payment_reminder_12h_sent_at: string | null;
  payment_reminder_23h_sent_at: string | null;
  status: string;
  awaiting_since: Date;
}

export interface ReminderResult {
  orderId: string;
  orderRef: string;
  kind: "12h" | "23h";
  sent: boolean;
  skipped?: string;
  messageId?: string;
  checkoutUrlIncluded: boolean;
  error?: string;
}

export interface CancelResult {
  orderId: string;
  orderRef: string;
  via: "cancelAwaitingPaymentOrder";
  action: string;
  performed?: boolean;
  checkoutExpireOutcome?: string;
  outboundMessageId?: string;
  error?: string;
}

export interface PaymentChaseRunResult {
  reminders12h: ReminderResult[];
  reminders23h: ReminderResult[];
  cancelled: CancelResult[];
}

interface CustomerRow {
  id: string;
  phone_e164: string;
}

/**
 * Process unpaid AWAITING_PAYMENT orders: 12h/23h WhatsApp reminders, then
 * 24h auto-cancel via the existing cancelAwaitingPaymentOrder path.
 *
 * 24h expiry — who wins:
 *   payment_chase owns the buyer-facing outcome (CANCELLED + timeout
 *   notify). Stripe's checkout.session.expired webhook is the stock-release
 *   backstop (EXPIRED). They land at ~the same instant because Checkout
 *   Session expires_at and reserved_until are both ~24h.
 *
 *   Webhook first: CAS AWAITING_PAYMENT → EXPIRED (stock released once).
 *   Chase then upgrades EXPIRED → CANCELLED (no second stock decrement)
 *   and notifies the buyer.
 *
 *   Chase first: expire session + CAS AWAITING_PAYMENT → CANCELLED + notify.
 *   The subsequent checkout.session.expired webhook sees CANCELLED and
 *   releaseOrderReservation no-ops.
 *
 * Idempotent under overlapping invocations: reminder sends are claimed by an
 * atomic NULL → NOW() update on *_sent_at; cancels rely on the CAS inside
 * releaseOrderReservation / the EXPIRED→CANCELLED update.
 */
export async function runPaymentChase(
  supabase: SupabaseClient,
): Promise<PaymentChaseRunResult> {
  const candidates = await loadPaymentChaseCandidates(supabase);
  const now = Date.now();

  const reminders12h: ReminderResult[] = [];
  const reminders23h: ReminderResult[] = [];
  const cancelled: CancelResult[] = [];

  for (const order of candidates) {
    const ageMs = now - order.awaiting_since.getTime();

    if (ageMs >= AUTO_CANCEL_MS) {
      cancelled.push(await autoCancelOrder(supabase, order));
      continue;
    }

    // EXPIRED orders only belong on the 24h cancel path (webhook already ran).
    if (order.status !== ORDER_STATUS.AWAITING_PAYMENT) {
      continue;
    }

    if (ageMs >= REMINDER_12H_MS && !order.payment_reminder_12h_sent_at) {
      reminders12h.push(
        await sendReminder(supabase, order, "12h", "payment_reminder_12h_sent_at"),
      );
    }

    if (ageMs >= REMINDER_23H_MS && !order.payment_reminder_23h_sent_at) {
      reminders23h.push(
        await sendReminder(supabase, order, "23h", "payment_reminder_23h_sent_at"),
      );
    }
  }

  return { reminders12h, reminders23h, cancelled };
}

async function loadPaymentChaseCandidates(
  supabase: SupabaseClient,
): Promise<ChaseOrder[]> {
  const { data: orders, error } = await supabase
    .from("orders")
    .select(
      "id, business_id, customer_id, thread_id, order_ref, status, stripe_checkout_session_id, payment_reminder_12h_sent_at, payment_reminder_23h_sent_at",
    )
    .in("status", [ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.EXPIRED])
    .is("deleted_at", null);

  if (error) {
    throw new Error(`payment-chase order lookup failed: ${error.message}`);
  }
  if (!orders?.length) return [];

  const ids = orders.map((row) => row.id as string);
  const { data: history, error: historyError } = await supabase
    .from("order_status_history")
    .select("order_id, changed_at")
    .in("order_id", ids)
    .eq("to_status", ORDER_STATUS.AWAITING_PAYMENT)
    .order("changed_at", { ascending: false });

  if (historyError) {
    throw new Error(
      `payment-chase status-history lookup failed: ${historyError.message}`,
    );
  }

  const latestIntoAwaiting = new Map<string, Date>();
  for (const row of history ?? []) {
    const orderId = row.order_id as string;
    if (latestIntoAwaiting.has(orderId)) continue;
    latestIntoAwaiting.set(orderId, new Date(row.changed_at as string));
  }

  const candidates: ChaseOrder[] = [];
  for (const row of orders) {
    const awaitingSince = latestIntoAwaiting.get(row.id as string);
    if (!awaitingSince) {
      console.warn("[payment-chase] order missing AWAITING_PAYMENT status history", {
        orderId: row.id,
      });
      continue;
    }
    candidates.push({
      id: row.id as string,
      business_id: row.business_id as string,
      customer_id: (row.customer_id as string | null) ?? null,
      thread_id: (row.thread_id as string | null) ?? null,
      order_ref: row.order_ref as string,
      stripe_checkout_session_id:
        (row.stripe_checkout_session_id as string | null) ?? null,
      payment_reminder_12h_sent_at:
        (row.payment_reminder_12h_sent_at as string | null) ?? null,
      payment_reminder_23h_sent_at:
        (row.payment_reminder_23h_sent_at as string | null) ?? null,
      status: row.status as string,
      awaiting_since: awaitingSince,
    });
  }
  return candidates;
}

async function claimReminder(
  supabase: SupabaseClient,
  orderId: string,
  column: ReminderColumn,
): Promise<string | null> {
  const claimedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("orders")
    .update({ [column]: claimedAt })
    .eq("id", orderId)
    .eq("status", ORDER_STATUS.AWAITING_PAYMENT)
    .is(column, null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[payment-chase] reminder claim failed", {
      orderId,
      column,
      error: error.message,
    });
    return null;
  }
  return data ? claimedAt : null;
}

async function unclaimReminder(
  supabase: SupabaseClient,
  orderId: string,
  column: ReminderColumn,
  claimedAt: string,
): Promise<void> {
  await supabase
    .from("orders")
    .update({ [column]: null })
    .eq("id", orderId)
    .eq(column, claimedAt);
}

async function sendReminder(
  supabase: SupabaseClient,
  order: ChaseOrder,
  kind: "12h" | "23h",
  column: ReminderColumn,
): Promise<ReminderResult> {
  const claimedAt = await claimReminder(supabase, order.id, column);
  if (!claimedAt) {
    return {
      orderId: order.id,
      orderRef: order.order_ref,
      kind,
      sent: false,
      skipped: "lost_claim",
      checkoutUrlIncluded: false,
    };
  }

  const customer = await loadCustomer(supabase, order);
  if (!customer) {
    await unclaimReminder(supabase, order.id, column, claimedAt);
    return {
      orderId: order.id,
      orderRef: order.order_ref,
      kind,
      sent: false,
      skipped: "no_customer",
      checkoutUrlIncluded: false,
    };
  }

  let checkoutUrl: string | null = null;
  if (order.stripe_checkout_session_id) {
    try {
      checkoutUrl = await getOpenCheckoutUrl(order.stripe_checkout_session_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[payment-chase] checkout lookup failed", {
        orderId: order.id,
        error: message,
      });
    }
  }

  const text = buildReminderText(kind, order.order_ref, checkoutUrl);

  try {
    const sent = await sendWhatsAppMessage({
      businessId: order.business_id,
      toPhoneE164: customer.phone_e164,
      text,
      threadId: order.thread_id,
      customerId: customer.id,
      supabase,
    });
    console.info("[payment-chase] reminder sent", {
      orderId: order.id,
      kind,
      messageId: sent.messageId,
      checkoutUrlIncluded: Boolean(checkoutUrl),
    });
    return {
      orderId: order.id,
      orderRef: order.order_ref,
      kind,
      sent: true,
      messageId: sent.messageId,
      checkoutUrlIncluded: Boolean(checkoutUrl),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[payment-chase] reminder send failed — releasing claim", {
      orderId: order.id,
      kind,
      error: message,
    });
    await unclaimReminder(supabase, order.id, column, claimedAt);
    return {
      orderId: order.id,
      orderRef: order.order_ref,
      kind,
      sent: false,
      checkoutUrlIncluded: Boolean(checkoutUrl),
      error: message,
    };
  }
}

function buildReminderText(
  kind: "12h" | "23h",
  orderRef: string,
  checkoutUrl: string | null,
): string {
  if (kind === "12h") {
    if (checkoutUrl) {
      return `Just a reminder — here's your secure payment link: ${checkoutUrl} — still valid.`;
    }
    return `Just a reminder — we haven't received payment for order ${orderRef} yet. Reply here if you'd still like to complete it.`;
  }
  if (checkoutUrl) {
    return `Final reminder — your order ${orderRef} will be cancelled in about an hour if we don't receive payment. Here's your secure payment link: ${checkoutUrl} — still valid.`;
  }
  return `Final reminder — your order ${orderRef} will be cancelled in about an hour if we don't receive payment. Reply here if you'd still like to complete it.`;
}

async function autoCancelOrder(
  supabase: SupabaseClient,
  order: ChaseOrder,
): Promise<CancelResult> {
  const customer = order.customer_id
    ? await loadCustomer(supabase, order)
    : null;

  const outcome = await cancelAwaitingPaymentOrder({
    supabase,
    businessId: order.business_id,
    orderId: order.id,
    notifyBuyer: Boolean(customer),
    customerId: customer?.id,
    customerPhoneE164: customer?.phone_e164,
    threadId: order.thread_id ?? undefined,
    buyerMessage: PAYMENT_CHASE_AUTO_CANCEL_MESSAGE,
  });

  if (outcome.action === "error") {
    return {
      orderId: order.id,
      orderRef: order.order_ref,
      via: "cancelAwaitingPaymentOrder",
      action: "error",
      error: outcome.error,
    };
  }

  return {
    orderId: order.id,
    orderRef: order.order_ref,
    via: "cancelAwaitingPaymentOrder",
    action: outcome.action,
    performed: outcome.performed,
    checkoutExpireOutcome: outcome.checkoutExpireOutcome,
    outboundMessageId: outcome.outboundMessageId,
  };
}

async function loadCustomer(
  supabase: SupabaseClient,
  order: ChaseOrder,
): Promise<CustomerRow | null> {
  if (!order.customer_id) return null;
  const { data, error } = await supabase
    .from("customers")
    .select("id, phone_e164")
    .eq("id", order.customer_id)
    .maybeSingle();
  if (error || !data?.phone_e164) return null;
  return { id: data.id as string, phone_e164: data.phone_e164 as string };
}
