import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isRateLimitFailure,
  RETRY_MAX_AGE_MS,
  retryBackoffMinutes,
} from "@/lib/channels/send/delivery";
import { isAiPaused } from "@/lib/inbox/ai-pause";
import { ORDER_STATUS } from "@/lib/orders/status";

export type PendingReplayStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "superseded"
  | "expired"
  | "failed";

export interface PendingReplayRow {
  id: string;
  inbound_message_id: string;
  business_id: string;
  customer_id: string;
  thread_id: string;
  status: PendingReplayStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  cancel_reason: string | null;
  created_at: string;
}

const MAX_ATTEMPTS = 3;

/**
 * Queue an inbound message for later replay when no buyer-facing reply
 * was delivered. Idempotent on inbound_message_id.
 */
export async function enqueuePendingReplay(params: {
  supabase: SupabaseClient;
  inboundMessageId: string;
  businessId: string;
  customerId: string;
  threadId: string;
  lastError: string;
  /** Minutes until first retry; default 30 (rate-limit friendly). */
  delayMinutes?: number;
}): Promise<{ id: string; created: boolean }> {
  const delay = params.delayMinutes ?? 30;
  const nextAttempt = new Date(Date.now() + delay * 60_000).toISOString();

  const { data: existing } = await params.supabase
    .from("pending_replays")
    .select("id, status")
    .eq("inbound_message_id", params.inboundMessageId)
    .maybeSingle();

  if (existing) {
    if (existing.status === "pending" || existing.status === "processing") {
      await params.supabase
        .from("pending_replays")
        .update({
          last_error: params.lastError,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      return { id: existing.id as string, created: false };
    }
    // Re-open succeeded/failed only if still pending path — leave terminal alone
    // unless we want to re-queue; for idempotency keep terminal.
    return { id: existing.id as string, created: false };
  }

  const { data, error } = await params.supabase
    .from("pending_replays")
    .insert({
      inbound_message_id: params.inboundMessageId,
      business_id: params.businessId,
      customer_id: params.customerId,
      thread_id: params.threadId,
      status: "pending",
      attempts: 0,
      max_attempts: MAX_ATTEMPTS,
      next_attempt_at: nextAttempt,
      last_error: params.lastError,
    })
    .select("id")
    .single();

  if (error) {
    // Unique race — treat as existing
    const { data: raced } = await params.supabase
      .from("pending_replays")
      .select("id")
      .eq("inbound_message_id", params.inboundMessageId)
      .maybeSingle();
    if (raced) return { id: raced.id as string, created: false };
    throw new Error(`enqueuePendingReplay failed: ${error.message}`);
  }

  console.info("[pending-replay] queued", {
    id: data.id,
    inboundMessageId: params.inboundMessageId,
    nextAttemptAt: nextAttempt,
  });
  return { id: data.id as string, created: true };
}

export type ReplayCancelDecision =
  | { cancel: false }
  | { cancel: true; status: "superseded" | "expired"; reason: string };

/**
 * Cancel when: newer inbound on thread, seller replied / AI paused,
 * order no longer awaiting confirmation (if a draft context applies),
 * or item older than 12 hours.
 */
export async function evaluateReplayCancellation(params: {
  supabase: SupabaseClient;
  row: PendingReplayRow;
}): Promise<ReplayCancelDecision> {
  const ageMs = Date.now() - new Date(params.row.created_at).getTime();
  if (Number.isFinite(ageMs) && ageMs > RETRY_MAX_AGE_MS) {
    return {
      cancel: true,
      status: "expired",
      reason: "Queued longer than 12 hours — replay expired",
    };
  }

  const { data: newerInbound } = await params.supabase
    .from("messages")
    .select("id")
    .eq("thread_id", params.row.thread_id)
    .eq("direction", "inbound")
    .neq("id", params.row.inbound_message_id)
    .gt("created_at", params.row.created_at)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (newerInbound) {
    return {
      cancel: true,
      status: "superseded",
      reason: "Newer inbound on thread — replay superseded",
    };
  }

  const { data: customer } = await params.supabase
    .from("customers")
    .select("ai_paused_until")
    .eq("id", params.row.customer_id)
    .maybeSingle();
  if (isAiPaused(customer?.ai_paused_until as string | null)) {
    return {
      cancel: true,
      status: "superseded",
      reason: "Seller paused AI / replied manually — replay cancelled",
    };
  }

  // Seller outbound after this inbound was queued → manual reply
  const { data: sellerOutbounds } = await params.supabase
    .from("messages")
    .select("id, raw_payload, normalised_text")
    .eq("thread_id", params.row.thread_id)
    .eq("direction", "outbound")
    .gt("created_at", params.row.created_at)
    .in("delivery_status", ["sent", "simulated"])
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(5);
  for (const full of sellerOutbounds ?? []) {
    const raw = (full.raw_payload ?? {}) as Record<string, unknown>;
    const text = (full.normalised_text as string | null) ?? "";
    const isApology =
      raw.kind === "processing_apology" ||
      /something went wrong on our side/i.test(text) ||
      /quelque chose a mal tourné/i.test(text);
    const isSystem =
      isApology ||
      raw.kind === "failed_processing" ||
      String(text).startsWith("[Processing error]");
    if (!isSystem) {
      return {
        cancel: true,
        status: "superseded",
        reason: "Seller replied manually — replay cancelled",
      };
    }
  }

  // Order moved on (paid / awaiting payment / etc.) — don't re-apply.
  const { data: pendingDraft } = await params.supabase
    .from("orders")
    .select("id")
    .eq("business_id", params.row.business_id)
    .eq("thread_id", params.row.thread_id)
    .eq("status", ORDER_STATUS.PENDING_CONFIRMATION)
    .is("deleted_at", null)
    .maybeSingle();
  if (!pendingDraft) {
    const { data: advanced } = await params.supabase
      .from("orders")
      .select("id, status")
      .eq("business_id", params.row.business_id)
      .eq("thread_id", params.row.thread_id)
      .not("status", "eq", ORDER_STATUS.CANCELLED)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (
      advanced &&
      advanced.status !== ORDER_STATUS.PENDING_CONFIRMATION
    ) {
      return {
        cancel: true,
        status: "superseded",
        reason: `Order is ${advanced.status}, no longer awaiting confirmation — replay cancelled`,
      };
    }
  }

  return { cancel: false };
}

/**
 * Cheap probe: do not burn Twilio quota. Returns false when a recent
 * account/business rate-limit means we should wait.
 */
export async function canAttemptSendProbe(params: {
  supabase: SupabaseClient;
  businessId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  // Cheap probe: look at recent rate-limit failures that still have a future
  // next_retry_at. Does not call Twilio (no quota burn).
  // Skip rows that are state-dependent (no outbound text retry scheduled).
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data } = await params.supabase
    .from("messages")
    .select("id, next_retry_at, delivery_error_code, created_at")
    .eq("business_id", params.businessId)
    .eq("direction", "outbound")
    .eq("delivery_status", "failed")
    .eq("delivery_error_code", "63038")
    .not("next_retry_at", "is", null)
    .gt("next_retry_at", new Date().toISOString())
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data?.next_retry_at) {
    return {
      ok: false,
      reason: `rate_limit_backoff_until_${data.next_retry_at}`,
    };
  }

  return { ok: true };
}

export function nextReplayAttemptAt(attemptsAfterThis: number): string | null {
  // attemptsAfterThis is the count after incrementing (1, 2, 3)
  if (attemptsAfterThis >= MAX_ATTEMPTS) return null;
  const minutes = retryBackoffMinutes({
    attemptJustFinished: attemptsAfterThis,
    rateLimited: true,
  });
  if (minutes == null) return null;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function markReplayTerminal(
  supabase: SupabaseClient,
  id: string,
  status: "superseded" | "expired" | "succeeded" | "failed",
  reason: string | null,
): Promise<void> {
  await supabase
    .from("pending_replays")
    .update({
      status,
      cancel_reason: reason,
      last_error: reason,
      next_attempt_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

export async function countPendingReplays(
  supabase: SupabaseClient,
  businessId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("pending_replays")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", "pending");
  if (error) {
    console.error("[pending-replay] count failed", error.message);
    return 0;
  }
  return count ?? 0;
}

export async function cancelPendingReplaysForThread(params: {
  supabase: SupabaseClient;
  businessId: string;
  threadId: string;
  reason: string;
}): Promise<number> {
  const { data, error } = await params.supabase
    .from("pending_replays")
    .update({
      status: "superseded",
      cancel_reason: params.reason,
      last_error: params.reason,
      next_attempt_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", params.businessId)
    .eq("thread_id", params.threadId)
    .eq("status", "pending")
    .select("id");
  if (error) {
    console.error("[pending-replay] cancel thread failed", error.message);
    return 0;
  }
  return data?.length ?? 0;
}

export async function cancelPendingReplaysForCustomer(params: {
  supabase: SupabaseClient;
  businessId: string;
  customerId: string;
  reason: string;
}): Promise<number> {
  const { data, error } = await params.supabase
    .from("pending_replays")
    .update({
      status: "superseded",
      cancel_reason: params.reason,
      last_error: params.reason,
      next_attempt_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", params.businessId)
    .eq("customer_id", params.customerId)
    .eq("status", "pending")
    .select("id");
  if (error) {
    console.error("[pending-replay] cancel customer failed", error.message);
    return 0;
  }
  return data?.length ?? 0;
}

export function isRateLimitErrorMessage(message: string): boolean {
  return (
    isRateLimitFailure({ twilioCode: 63038, twilioStatus: 429 }) ||
    /63038|daily messages limit|rate limit/i.test(message)
  );
}

/** Used when draft is gone / not confirming — still allow replay for questions. */
export async function threadHasConfirmableDraft(
  supabase: SupabaseClient,
  businessId: string,
  threadId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("orders")
    .select("id")
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .eq("status", ORDER_STATUS.PENDING_CONFIRMATION)
    .is("deleted_at", null)
    .maybeSingle();
  return Boolean(data);
}
