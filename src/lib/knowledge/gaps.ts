import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normaliseQuestionForHash,
  scrubKnowledgeGapQuestion,
} from "@/lib/knowledge/scrub";
import { createAdminClient } from "@/lib/supabase/admin";

export function hashKnowledgeQuestion(normalised: string): string {
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/**
 * Log or increment an open knowledge gap. Never stores customer/order/message ids.
 * Failures are swallowed by the caller — buyer reply must still go out.
 */
export async function logKnowledgeGap(params: {
  businessId: string;
  productId?: string | null;
  questionText: string;
  supabase?: SupabaseClient;
}): Promise<{ id: string; timesAsked: number } | null> {
  const supabase = params.supabase ?? createAdminClient();
  const scrubbed = scrubKnowledgeGapQuestion(params.questionText);
  if (!scrubbed) return null;

  const hash = hashKnowledgeQuestion(normaliseQuestionForHash(scrubbed));
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from("ai_knowledge_gaps")
    .select("id, times_asked")
    .eq("business_id", params.businessId)
    .eq("question_hash", hash)
    .eq("status", "open")
    .maybeSingle();

  if (existing?.id) {
    const next = (existing.times_asked ?? 1) + 1;
    const { error } = await supabase
      .from("ai_knowledge_gaps")
      .update({
        times_asked: next,
        last_asked_at: now,
        ...(params.productId ? { product_id: params.productId } : {}),
      })
      .eq("id", existing.id)
      .eq("business_id", params.businessId);
    if (error) {
      console.error("[knowledge/gaps] increment failed", error.message);
      return null;
    }
    return { id: existing.id as string, timesAsked: next };
  }

  const { data: inserted, error } = await supabase
    .from("ai_knowledge_gaps")
    .insert({
      business_id: params.businessId,
      product_id: params.productId ?? null,
      question_text: scrubbed,
      question_hash: hash,
      times_asked: 1,
      first_asked_at: now,
      last_asked_at: now,
      status: "open",
    })
    .select("id, times_asked")
    .single();

  if (error) {
    console.error("[knowledge/gaps] insert failed", error.message);
    return null;
  }
  return {
    id: inserted.id as string,
    timesAsked: (inserted.times_asked as number) ?? 1,
  };
}

export async function countOpenKnowledgeGaps(
  businessId: string,
  supabase: SupabaseClient,
): Promise<number> {
  const { count, error } = await supabase
    .from("ai_knowledge_gaps")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", "open");
  if (error) return 0;
  return count ?? 0;
}
