import type { SupabaseClient } from "@supabase/supabase-js";

import { isAiPaused } from "@/lib/inbox/ai-pause";
import {
  resolveThreadStatus,
  type InboxThreadStatus,
} from "@/lib/inbox/status";
import { unwrapRelation } from "@/lib/orders/display";
import { ORDER_STATUS } from "@/lib/orders/status";

export type InboxThreadSummary = {
  threadId: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  lastMessagePreview: string;
  lastMessageAt: string;
  lastDirection: string;
  status: InboxThreadStatus;
  aiPaused: boolean;
  aiPausedUntil: string | null;
};

const MESSAGE_SCAN_LIMIT = 1500;

const PLACED_STATUSES = new Set<string>([
  ORDER_STATUS.PENDING_CONFIRMATION,
  ORDER_STATUS.AWAITING_PAYMENT,
  ORDER_STATUS.PAID,
  ORDER_STATUS.DISPATCHED,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.REFUND_PENDING,
  ORDER_STATUS.PARTIALLY_REFUNDED,
  ORDER_STATUS.REFUNDED,
]);

function previewText(value: string | null): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "(no text)";
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/**
 * Group the seller's messages into conversation threads, newest activity first.
 */
export async function listInboxThreads(
  supabase: SupabaseClient,
): Promise<InboxThreadSummary[]> {
  const { data: rows, error } = await supabase
    .from("messages")
    .select(
      "id, thread_id, customer_id, direction, normalised_text, ai_parse_result, created_at, customers(phone_e164, name, ai_paused_until)",
    )
    .not("thread_id", "is", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(MESSAGE_SCAN_LIMIT);

  if (error) throw new Error(error.message);

  const byThread = new Map<
    string,
    {
      threadId: string;
      customerId: string | null;
      customerName: string | null;
      customerPhone: string | null;
      lastMessagePreview: string;
      lastMessageAt: string;
      lastDirection: string;
      lastInboundParse: unknown;
      aiPausedUntil: string | null;
    }
  >();

  for (const row of rows ?? []) {
    const threadId = row.thread_id as string | null;
    if (!threadId) continue;
    const customer = unwrapRelation(
      row.customers as
        | {
            phone_e164: string;
            name: string | null;
            ai_paused_until: string | null;
          }
        | {
            phone_e164: string;
            name: string | null;
            ai_paused_until: string | null;
          }[]
        | null,
    );

    const existing = byThread.get(threadId);
    if (!existing) {
      byThread.set(threadId, {
        threadId,
        customerId: (row.customer_id as string | null) ?? null,
        customerName: customer?.name ?? null,
        customerPhone: customer?.phone_e164 ?? null,
        lastMessagePreview: previewText(row.normalised_text as string | null),
        lastMessageAt: row.created_at as string,
        lastDirection: row.direction as string,
        lastInboundParse:
          row.direction === "inbound" ? row.ai_parse_result : null,
        aiPausedUntil: customer?.ai_paused_until ?? null,
      });
      continue;
    }

    if (existing.lastInboundParse == null && row.direction === "inbound") {
      existing.lastInboundParse = row.ai_parse_result;
    }
    if (!existing.customerPhone && customer?.phone_e164) {
      existing.customerPhone = customer.phone_e164;
      existing.customerName = customer.name ?? existing.customerName;
    }
    if (!existing.aiPausedUntil && customer?.ai_paused_until) {
      existing.aiPausedUntil = customer.ai_paused_until;
    }
  }

  const threadIds = [...byThread.keys()];
  const placed = new Set<string>();
  if (threadIds.length > 0) {
    const { data: orders, error: orderError } = await supabase
      .from("orders")
      .select("thread_id, status")
      .in("thread_id", threadIds)
      .is("deleted_at", null);
    if (orderError) throw new Error(orderError.message);
    for (const order of orders ?? []) {
      const threadId = order.thread_id as string | null;
      if (!threadId) continue;
      if (PLACED_STATUSES.has(order.status as string)) {
        placed.add(threadId);
      }
    }
  }

  return [...byThread.values()]
    .map((thread) => {
      const aiPaused = isAiPaused(thread.aiPausedUntil);
      return {
        threadId: thread.threadId,
        customerId: thread.customerId,
        customerName: thread.customerName,
        customerPhone: thread.customerPhone,
        lastMessagePreview: thread.lastMessagePreview,
        lastMessageAt: thread.lastMessageAt,
        lastDirection: thread.lastDirection,
        aiPaused,
        aiPausedUntil: aiPaused ? thread.aiPausedUntil : null,
        status: resolveThreadStatus({
          lastInboundParse: thread.lastInboundParse,
          lastDirection: thread.lastDirection,
          hasPlacedOrder: placed.has(thread.threadId),
          aiPaused,
        }),
      };
    })
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
}
