import type { SupabaseClient } from "@supabase/supabase-js";

import {
  canAttemptSendProbe,
  evaluateReplayCancellation,
  markReplayTerminal,
  nextReplayAttemptAt,
  type PendingReplayRow,
} from "@/lib/channels/pending-replay";
import { replayInboundMessage } from "@/lib/channels/replay-inbound";

const BATCH_LIMIT = 20;

export interface PendingReplayRunResult {
  examined: number;
  replayed: number;
  succeeded: number;
  failed: number;
  superseded: number;
  expired: number;
  skippedProbe: number;
}

/**
 * Replay pending inbound messages that never got a delivered buyer reply.
 */
export async function runPendingReplay(
  supabase: SupabaseClient,
): Promise<PendingReplayRunResult> {
  const now = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("pending_replays")
    .select(
      "id, inbound_message_id, business_id, customer_id, thread_id, status, attempts, max_attempts, next_attempt_at, last_error, cancel_reason, created_at",
    )
    .eq("status", "pending")
    .not("next_attempt_at", "is", null)
    .lte("next_attempt_at", now)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new Error(`pending_replay lookup failed: ${error.message}`);
  }

  let examined = 0;
  let replayed = 0;
  let succeeded = 0;
  let failed = 0;
  let superseded = 0;
  let expired = 0;
  let skippedProbe = 0;

  for (const raw of due ?? []) {
    const row = raw as PendingReplayRow;
    examined += 1;

    const cancel = await evaluateReplayCancellation({ supabase, row });
    if (cancel.cancel) {
      await markReplayTerminal(supabase, row.id, cancel.status, cancel.reason);
      if (cancel.status === "expired") expired += 1;
      else superseded += 1;
      continue;
    }

    const probe = await canAttemptSendProbe({
      supabase,
      businessId: row.business_id,
    });
    if (!probe.ok) {
      skippedProbe += 1;
      // Push next_attempt a bit without burning an attempt.
      await supabase
        .from("pending_replays")
        .update({
          next_attempt_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          last_error: probe.reason ?? "probe_blocked",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "pending");
      continue;
    }

    // Claim
    const { data: claimed } = await supabase
      .from("pending_replays")
      .update({
        status: "processing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    replayed += 1;
    const attempts = row.attempts + 1;

    try {
      const result = await replayInboundMessage({
        supabase,
        inboundMessageId: row.inbound_message_id,
      });

      if (result.buyerReplyDelivered) {
        await supabase
          .from("pending_replays")
          .update({
            attempts,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        await markReplayTerminal(supabase, row.id, "succeeded", result.detail);
        succeeded += 1;
        continue;
      }

      // Reply failed again — draft already reverted inside createDraftOrder.
      const next = nextReplayAttemptAt(attempts);
      if (!next || attempts >= row.max_attempts) {
        await markReplayTerminal(
          supabase,
          row.id,
          "failed",
          result.detail || "max attempts",
        );
        failed += 1;
      } else {
        await supabase
          .from("pending_replays")
          .update({
            status: "pending",
            attempts,
            next_attempt_at: next,
            last_error: result.detail,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        failed += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const next = nextReplayAttemptAt(attempts);
      if (!next || attempts >= row.max_attempts) {
        await markReplayTerminal(supabase, row.id, "failed", message);
      } else {
        await supabase
          .from("pending_replays")
          .update({
            status: "pending",
            attempts,
            next_attempt_at: next,
            last_error: message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }
      failed += 1;
      console.error("[pending-replay] replay threw", {
        id: row.id,
        error: message,
      });
    }
  }

  return {
    examined,
    replayed,
    succeeded,
    failed,
    superseded,
    expired,
    skippedProbe,
  };
}
