import Link from "next/link";

import { KnowledgeGapActions } from "./gap-actions";
import { requireSeller } from "../require-seller";

export default async function KnowledgeGapsPage() {
  const { supabase, businessId } = await requireSeller();

  const { data: gaps } = await supabase
    .from("ai_knowledge_gaps")
    .select(
      "id, question_text, times_asked, last_asked_at, product_id, status, products(name)",
    )
    .eq("business_id", businessId)
    .eq("status", "open")
    .order("last_asked_at", { ascending: false })
    .limit(50);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/dashboard/orders"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Dashboard
        </Link>
        <h1 className="tf-page-heading mt-3">
          Questions the AI could not answer
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Answer once to save a FAQ the AI can use next time. No customer
          details are stored here.
        </p>
      </div>

      {!gaps?.length ? (
        <p className="text-sm text-muted-foreground">No open questions.</p>
      ) : (
        <ul className="space-y-4">
          {gaps.map((gap) => {
            const productName =
              gap.products &&
              typeof gap.products === "object" &&
              "name" in gap.products
                ? String((gap.products as { name?: string }).name ?? "")
                : null;
            return (
              <li
                key={gap.id as string}
                className="space-y-3 rounded-lg border p-4"
              >
                <p className="text-sm font-medium">{gap.question_text as string}</p>
                <p className="text-xs text-muted-foreground">
                  {productName ? `Product: ${productName} · ` : "Shop-level · "}
                  Asked {gap.times_asked as number}× · Last{" "}
                  {new Date(gap.last_asked_at as string).toLocaleString()}
                </p>
                <KnowledgeGapActions
                  gapId={gap.id as string}
                  question={gap.question_text as string}
                  hasProduct={Boolean(gap.product_id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
