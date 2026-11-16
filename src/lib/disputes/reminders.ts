import type { SupabaseClient } from "@supabase/supabase-js";

import { DISPUTE_AUTO_SUBMIT_HOURS_BEFORE } from "@/lib/disputes/constants";
import { submitDisputeEvidence } from "@/lib/disputes/evidence";
import {
  notifySellerDisputeAutoSubmitted,
  notifySellerDisputeReminder,
} from "@/lib/disputes/notify";

export type DisputeRemindersResult = {
  reminders5d: string[];
  reminders2d: string[];
  reminders1d: string[];
  autoSubmitted: string[];
  errors: { disputeId: string; error: string }[];
};

type ReminderDispute = {
  id: string;
  business_id: string;
  order_id: string | null;
  evidence_due_by: string;
  evidence_status: string;
  evidence_submitted_at: string | null;
  reminder_5d_sent_at: string | null;
  reminder_2d_sent_at: string | null;
  reminder_1d_sent_at: string | null;
  auto_submit_notified_at: string | null;
  closed_at: string | null;
  orders: { order_ref: string } | { order_ref: string }[] | null;
};

function orderRefOf(row: ReminderDispute): string {
  const o = row.orders;
  if (Array.isArray(o)) return o[0]?.order_ref ?? "unknown";
  return o?.order_ref ?? "unknown";
}

/**
 * Send 5d/2d/1d reminders (once each) and auto-submit packs that are within
 * DISPUTE_AUTO_SUBMIT_HOURS_BEFORE of the deadline and still unsubmitted.
 * `now` is injectable for time-travel tests.
 */
export async function runDisputeReminders(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<DisputeRemindersResult> {
  const result: DisputeRemindersResult = {
    reminders5d: [],
    reminders2d: [],
    reminders1d: [],
    autoSubmitted: [],
    errors: [],
  };

  const { data, error } = await supabase
    .from("disputes")
    .select(
      "id, business_id, order_id, evidence_due_by, evidence_status, evidence_submitted_at, reminder_5d_sent_at, reminder_2d_sent_at, reminder_1d_sent_at, auto_submit_notified_at, closed_at, orders(order_ref)",
    )
    .is("closed_at", null)
    .not("evidence_due_by", "is", null)
    .in("evidence_status", ["draft", "ready"]);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ReminderDispute[];
  const nowMs = now.getTime();

  for (const row of rows) {
    if (row.evidence_submitted_at || row.evidence_status === "submitted") {
      continue;
    }
    if (!row.evidence_due_by) continue;

    const dueMs = new Date(row.evidence_due_by).getTime();
    if (!Number.isFinite(dueMs)) continue;

    const msUntil = dueMs - nowMs;
    const daysUntil = msUntil / (24 * 60 * 60 * 1000);
    const hoursUntil = msUntil / (60 * 60 * 1000);
    const orderRef = orderRefOf(row);

    try {
      // Auto-submit first if within the window (or past due).
      if (hoursUntil <= DISPUTE_AUTO_SUBMIT_HOURS_BEFORE) {
        await submitDisputeEvidence(supabase, {
          disputeId: row.id,
          businessId: row.business_id,
          submittedBy: "auto",
        });
        result.autoSubmitted.push(row.id);

        if (!row.auto_submit_notified_at) {
          await notifySellerDisputeAutoSubmitted({
            supabase,
            businessId: row.business_id,
            orderRef,
          });
          await supabase
            .from("disputes")
            .update({
              auto_submit_notified_at: now.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq("id", row.id)
            .is("auto_submit_notified_at", null);
        }
        continue;
      }

      // Reminders: fire when we are at or past the N-day mark, once each.
      // 5d: due within 5 days but more than 2 days away
      // 2d: due within 2 days but more than 1 day away
      // 1d: due within 1 day but more than auto-submit window
      if (daysUntil <= 5 && !row.reminder_5d_sent_at) {
        await notifySellerDisputeReminder({
          supabase,
          businessId: row.business_id,
          orderRef,
          evidenceDueBy: row.evidence_due_by,
        });
        await supabase
          .from("disputes")
          .update({
            reminder_5d_sent_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq("id", row.id)
          .is("reminder_5d_sent_at", null);
        result.reminders5d.push(row.id);
      }

      if (daysUntil <= 2 && !row.reminder_2d_sent_at) {
        await notifySellerDisputeReminder({
          supabase,
          businessId: row.business_id,
          orderRef,
          evidenceDueBy: row.evidence_due_by,
        });
        await supabase
          .from("disputes")
          .update({
            reminder_2d_sent_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq("id", row.id)
          .is("reminder_2d_sent_at", null);
        result.reminders2d.push(row.id);
      }

      if (daysUntil <= 1 && hoursUntil > DISPUTE_AUTO_SUBMIT_HOURS_BEFORE && !row.reminder_1d_sent_at) {
        await notifySellerDisputeReminder({
          supabase,
          businessId: row.business_id,
          orderRef,
          evidenceDueBy: row.evidence_due_by,
        });
        await supabase
          .from("disputes")
          .update({
            reminder_1d_sent_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq("id", row.id)
          .is("reminder_1d_sent_at", null);
        result.reminders1d.push(row.id);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message === "EVIDENCE_ALREADY_SUBMITTED") {
        continue;
      }
      result.errors.push({ disputeId: row.id, error: message });
      console.error("[disputes/reminders] failed", {
        disputeId: row.id,
        error: message,
      });
    }
  }

  return result;
}
