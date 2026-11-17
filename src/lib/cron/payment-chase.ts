import type { SupabaseClient } from "@supabase/supabase-js";

import { isVercelProduction } from "@/lib/api/runtime-env";
import {
  WhatsAppNotConfiguredError,
  WhatsAppSendError,
} from "@/lib/channels/send/errors";
import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import { t } from "@/lib/i18n";
import { cancelAwaitingPaymentOrder } from "@/lib/orders/confirm-draft-order";
import { ORDER_STATUS } from "@/lib/orders/status";
import { getOpenCheckoutUrl } from "@/lib/stripe/checkout";
import { notifySellerOfPaymentReminderFailed } from "@/lib/support/notify-seller";

const MS_PER_HOUR = 60 * 60 * 1000;
export const REMINDER_12H_MS = 12 * MS_PER_HOUR;
export const REMINDER_23H_MS = 23 * MS_PER_HOUR;
export const AUTO_CANCEL_MS = 24 * MS_PER_HOUR;
export const MAX_REMINDER_SEND_ATTEMPTS = 3;

type ReminderColumn =
  | "payment_reminder_12h_sent_at"
  | "payment_reminder_23h_sent_at";

type ReminderOutcomeColumn =
  | "payment_reminder_12h_outcome"
  | "payment_reminder_23h_outcome";

type ReminderAttemptsColumn =
  | "payment_reminder_12h_attempts"
  | "payment_reminder_23h_attempts";

type ReminderOutcome = "sent" | "skipped_no_channel" | "failed";

interface ChaseOrder {
  id: string;
  business_id: string;
  customer_id: string | null;
  thread_id: string | null;
  order_ref: string;
  stripe_checkout_session_id: string | null;
  payment_reminder_12h_sent_at: string | null;
  payment_reminder_23h_sent_at: string | null;
  payment_reminder_12h_outcome: string | null;
  payment_reminder_23h_outcome: string | null;
  payment_reminder_12h_attempts: number;
  payment_reminder_23h_attempts: number;
  payment_reminder_seller_alerted_at: string | null;
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
  /** Aggregate counts for heartbeat / logs (no personal data). */
  counts: {
    sent: number;
    skipped: number;
    failed: number;
    cancelled: number;
    cancelErrors: number;
  };
}

interface CustomerRow {
  id: string;
  phone_e164: string;
  preferred_language: string | null;
}

/**
 * Process unpaid AWAITING_PAYMENT orders: 12h/23h WhatsApp reminders, then
 * 24h auto-cancel via the existing cancelAwaitingPaymentOrder path.
 *
 * Per-order problems never throw out of the run. No-channel reminders are
 * skipped permanently; send failures retry up to MAX_REMINDER_SEND_ATTEMPTS.
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
    try {
      const ageMs = now - order.awaiting_since.getTime();

      if (ageMs >= AUTO_CANCEL_MS) {
        cancelled.push(await autoCancelOrder(supabase, order));
        continue;
      }

      // EXPIRED orders only belong on the 24h cancel path (webhook already ran).
      if (order.status !== ORDER_STATUS.AWAITING_PAYMENT) {
        continue;
      }

      if (
        ageMs >= REMINDER_12H_MS &&
        !order.payment_reminder_12h_sent_at &&
        !order.payment_reminder_12h_outcome
      ) {
        reminders12h.push(
          await sendReminder(supabase, order, "12h", {
            sentAt: "payment_reminder_12h_sent_at",
            outcome: "payment_reminder_12h_outcome",
            attempts: "payment_reminder_12h_attempts",
          }),
        );
      }

      if (
        ageMs >= REMINDER_23H_MS &&
        !order.payment_reminder_23h_sent_at &&
        !order.payment_reminder_23h_outcome
      ) {
        reminders23h.push(
          await sendReminder(supabase, order, "23h", {
            sentAt: "payment_reminder_23h_sent_at",
            outcome: "payment_reminder_23h_outcome",
            attempts: "payment_reminder_23h_attempts",
          }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[payment-chase] per-order error (continuing)", {
        orderId: order.id,
        error: message.slice(0, 180),
      });
      cancelled.push({
        orderId: order.id,
        orderRef: order.order_ref,
        via: "cancelAwaitingPaymentOrder",
        action: "error",
        error: message.slice(0, 180),
      });
    }
  }

  const allReminders = [...reminders12h, ...reminders23h];
  const counts = {
    sent: allReminders.filter((r) => r.sent).length,
    skipped: allReminders.filter(
      (r) => Boolean(r.skipped) && r.skipped !== "failed_permanent",
    ).length,
    failed: allReminders.filter(
      (r) =>
        r.skipped === "failed_permanent" ||
        (Boolean(r.error) && !r.sent && !r.skipped),
    ).length,
    cancelled: cancelled.filter((c) => c.action !== "error").length,
    cancelErrors: cancelled.filter((c) => c.action === "error").length,
  };

  return { reminders12h, reminders23h, cancelled, counts };
}

async function loadPaymentChaseCandidates(
  supabase: SupabaseClient,
): Promise<ChaseOrder[]> {
  const { data: orders, error } = await supabase
    .from("orders")
    .select(
      "id, business_id, customer_id, thread_id, order_ref, status, stripe_checkout_session_id, payment_reminder_12h_sent_at, payment_reminder_23h_sent_at, payment_reminder_12h_outcome, payment_reminder_23h_outcome, payment_reminder_12h_attempts, payment_reminder_23h_attempts, payment_reminder_seller_alerted_at",
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
      payment_reminder_12h_outcome:
        (row.payment_reminder_12h_outcome as string | null) ?? null,
      payment_reminder_23h_outcome:
        (row.payment_reminder_23h_outcome as string | null) ?? null,
      payment_reminder_12h_attempts:
        Number(row.payment_reminder_12h_attempts ?? 0) || 0,
      payment_reminder_23h_attempts:
        Number(row.payment_reminder_23h_attempts ?? 0) || 0,
      payment_reminder_seller_alerted_at:
        (row.payment_reminder_seller_alerted_at as string | null) ?? null,
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

async function finalizeReminder(
  supabase: SupabaseClient,
  orderId: string,
  cols: {
    sentAt: ReminderColumn;
    outcome: ReminderOutcomeColumn;
    attempts: ReminderAttemptsColumn;
  },
  params: {
    outcome: ReminderOutcome;
    attempts: number;
    claimedAt: string;
  },
): Promise<void> {
  await supabase
    .from("orders")
    .update({
      [cols.sentAt]: params.claimedAt,
      [cols.outcome]: params.outcome,
      [cols.attempts]: params.attempts,
    })
    .eq("id", orderId);
}

async function sendReminder(
  supabase: SupabaseClient,
  order: ChaseOrder,
  kind: "12h" | "23h",
  cols: {
    sentAt: ReminderColumn;
    outcome: ReminderOutcomeColumn;
    attempts: ReminderAttemptsColumn;
  },
): Promise<ReminderResult> {
  const priorAttempts =
    kind === "12h"
      ? order.payment_reminder_12h_attempts
      : order.payment_reminder_23h_attempts;

  const claimedAt = await claimReminder(supabase, order.id, cols.sentAt);
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
  if (!customer?.phone_e164) {
    await finalizeReminder(supabase, order.id, cols, {
      outcome: "skipped_no_channel",
      attempts: priorAttempts,
      claimedAt,
    });
    console.info("[payment-chase] reminder_skipped", {
      orderId: order.id,
      kind,
      reason: "no_channel",
      detail: "no_customer_phone",
    });
    return {
      orderId: order.id,
      orderRef: order.order_ref,
      kind,
      sent: false,
      skipped: "no_channel",
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
        error: message.slice(0, 180),
      });
    }
  }

  const text = buildReminderText(
    kind,
    order.order_ref,
    checkoutUrl,
    customer.preferred_language,
  );

  try {
    // Verification-only hook — never active on Vercel production.
    if (
      process.env.PAYMENT_CHASE_FORCE_SEND_ERROR === "1" &&
      !isVercelProduction()
    ) {
      throw new WhatsAppSendError("forced_test_send_failure");
    }
    const sent = await sendWhatsAppMessage({
      businessId: order.business_id,
      toPhoneE164: customer.phone_e164,
      text,
      threadId: order.thread_id,
      customerId: customer.id,
      supabase,
      templateLanguage: customer.preferred_language,
      template: {
        key: "payment_reminder",
        variables: {
          orderRef: order.order_ref,
          url:
            checkoutUrl ??
            t("chase.reminder_url_fallback", customer.preferred_language),
        },
      },
    });
    await finalizeReminder(supabase, order.id, cols, {
      outcome: "sent",
      attempts: priorAttempts + 1,
      claimedAt,
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
    const noChannel =
      error instanceof WhatsAppNotConfiguredError ||
      /whatsapp_phone_e164 is null|WHATSAPP_NOT_CONFIGURED|no WhatsApp number/i.test(
        message,
      );

    if (noChannel) {
      await finalizeReminder(supabase, order.id, cols, {
        outcome: "skipped_no_channel",
        attempts: priorAttempts,
        claimedAt,
      });
      console.info("[payment-chase] reminder_skipped", {
        orderId: order.id,
        kind,
        reason: "no_channel",
      });
      return {
        orderId: order.id,
        orderRef: order.order_ref,
        kind,
        sent: false,
        skipped: "no_channel",
        checkoutUrlIncluded: Boolean(checkoutUrl),
      };
    }

    const attempts = priorAttempts + 1;
    if (attempts >= MAX_REMINDER_SEND_ATTEMPTS) {
      await finalizeReminder(supabase, order.id, cols, {
        outcome: "failed",
        attempts,
        claimedAt,
      });
      await maybeAlertSellerReminderFailed(supabase, order);
      console.error("[payment-chase] reminder permanently failed", {
        orderId: order.id,
        kind,
        attempts,
        error: message.slice(0, 180),
      });
      return {
        orderId: order.id,
        orderRef: order.order_ref,
        kind,
        sent: false,
        skipped: "failed_permanent",
        checkoutUrlIncluded: Boolean(checkoutUrl),
        error: message.slice(0, 180),
      };
    }

    await supabase
      .from("orders")
      .update({ [cols.attempts]: attempts })
      .eq("id", order.id);
    await unclaimReminder(supabase, order.id, cols.sentAt, claimedAt);
    console.error("[payment-chase] reminder send failed — will retry", {
      orderId: order.id,
      kind,
      attempts,
      error: message.slice(0, 180),
    });
    return {
      orderId: order.id,
      orderRef: order.order_ref,
      kind,
      sent: false,
      checkoutUrlIncluded: Boolean(checkoutUrl),
      error: message.slice(0, 180),
    };
  }
}

async function maybeAlertSellerReminderFailed(
  supabase: SupabaseClient,
  order: ChaseOrder,
): Promise<void> {
  if (order.payment_reminder_seller_alerted_at) return;
  const alertedAt = new Date().toISOString();
  const { data } = await supabase
    .from("orders")
    .update({ payment_reminder_seller_alerted_at: alertedAt })
    .eq("id", order.id)
    .is("payment_reminder_seller_alerted_at", null)
    .select("id")
    .maybeSingle();
  if (!data) return;

  await notifySellerOfPaymentReminderFailed({
    businessId: order.business_id,
    orderRef: order.order_ref,
    supabase,
  }).catch((err) => {
    console.error("[payment-chase] seller alert failed", {
      orderId: order.id,
      error: err instanceof Error ? err.message.slice(0, 180) : String(err),
    });
  });
}

function buildReminderText(
  kind: "12h" | "23h",
  orderRef: string,
  checkoutUrl: string | null,
  lang: string | null,
): string {
  if (kind === "12h") {
    if (checkoutUrl) {
      return t("chase.reminder_12h_with_url", lang, { url: checkoutUrl });
    }
    return t("chase.reminder_12h_no_url", lang, { orderRef });
  }
  if (checkoutUrl) {
    return t("chase.reminder_23h_with_url", lang, {
      orderRef,
      url: checkoutUrl,
    });
  }
  return t("chase.reminder_23h_no_url", lang, { orderRef });
}

async function autoCancelOrder(
  supabase: SupabaseClient,
  order: ChaseOrder,
): Promise<CancelResult> {
  try {
    const customer = order.customer_id
      ? await loadCustomer(supabase, order)
      : null;

    // Only notify when we have a channel; missing WA must not throw the job.
    let notifyBuyer = Boolean(customer?.phone_e164);
    if (notifyBuyer) {
      const { data: biz } = await supabase
        .from("businesses")
        .select("whatsapp_phone_e164")
        .eq("id", order.business_id)
        .maybeSingle();
      if (!biz?.whatsapp_phone_e164) notifyBuyer = false;
    }

    const outcome = await cancelAwaitingPaymentOrder({
      supabase,
      businessId: order.business_id,
      orderId: order.id,
      notifyBuyer,
      customerId: customer?.id,
      customerPhoneE164: customer?.phone_e164,
      threadId: order.thread_id ?? undefined,
      buyerMessage: t(
        "confirm.payment_auto_cancelled",
        customer?.preferred_language,
      ),
      template: {
        key: "order_auto_cancelled",
        variables: { orderRef: order.order_ref },
      },
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[payment-chase] auto-cancel error (continuing)", {
      orderId: order.id,
      error: message.slice(0, 180),
    });
    return {
      orderId: order.id,
      orderRef: order.order_ref,
      via: "cancelAwaitingPaymentOrder",
      action: "error",
      error: message.slice(0, 180),
    };
  }
}

async function loadCustomer(
  supabase: SupabaseClient,
  order: ChaseOrder,
): Promise<CustomerRow | null> {
  if (!order.customer_id) return null;
  const { data, error } = await supabase
    .from("customers")
    .select("id, phone_e164, preferred_language")
    .eq("id", order.customer_id)
    .maybeSingle();
  if (error || !data) return null;
  const phone = (data.phone_e164 as string | null)?.trim() || "";
  if (!phone) return null;
  return {
    id: data.id as string,
    phone_e164: phone,
    preferred_language: (data.preferred_language as string | null) ?? null,
  };
}
