import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { formatDateTime, unwrapRelation } from "@/lib/orders/display";
import { cn } from "@/lib/utils";
import { isAiPaused, isAiPausedSkip } from "@/lib/inbox/ai-pause";
import { isInServiceWindow } from "@/lib/channels/service-window";

import { requireSeller } from "../../require-seller";
import { ThreadAiPauseBanner, ThreadReplyForm } from "./thread-reply";

interface ThreadPageProps {
  params: Promise<{ threadId: string }>;
}

function formatParse(parse: unknown): {
  intent: string | null;
  confidence: string | null;
  needsClarification: boolean;
  escalateToSeller: boolean;
  clarification: string | null;
  items: Array<{
    query: string;
    variant: string | null;
    quantity: number;
    matchConfidence: number;
    matched: boolean;
  }>;
} | null {
  if (!parse || typeof parse !== "object") return null;
  const row = parse as Record<string, unknown>;
  const intent = typeof row.intent === "string" ? row.intent : null;
  const confidence =
    typeof row.confidence === "number"
      ? `${Math.round(row.confidence * 100)}%`
      : null;
  const itemsRaw = Array.isArray(row.items) ? row.items : [];
  return {
    intent,
    confidence,
    needsClarification: row.needs_clarification === true,
    escalateToSeller: row.escalate_to_seller === true,
    clarification:
      typeof row.clarification_message === "string"
        ? row.clarification_message
        : null,
    items: itemsRaw.map((item) => {
      const line = (item ?? {}) as Record<string, unknown>;
      return {
        query: typeof line.product_query === "string" ? line.product_query : "",
        variant:
          typeof line.variant_query === "string" ? line.variant_query : null,
        quantity: typeof line.quantity === "number" ? line.quantity : 1,
        matchConfidence:
          typeof line.match_confidence === "number" ? line.match_confidence : 0,
        matched: Boolean(line.matched_product_id),
      };
    }),
  };
}

export default async function InboxThreadPage({ params }: ThreadPageProps) {
  const { threadId } = await params;
  const { supabase } = await requireSeller();

  const { data: messages, error } = await supabase
    .from("messages")
    .select(
      "id, direction, normalised_text, ai_parse_result, created_at, customer_id, customers(phone_e164, name, last_customer_message_at, ai_paused_until)",
    )
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Conversation</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load this thread. {error.message}
        </p>
      </div>
    );
  }

  if (!messages?.length) notFound();

  const firstCustomer = unwrapRelation(
    messages.find((row) => row.customers)?.customers as
      | {
          phone_e164: string;
          name: string | null;
          last_customer_message_at: string | null;
          ai_paused_until: string | null;
        }
      | {
          phone_e164: string;
          name: string | null;
          last_customer_message_at: string | null;
          ai_paused_until: string | null;
        }[]
      | null,
  );

  const pausedUntil = firstCustomer?.ai_paused_until ?? null;
  const paused = isAiPaused(pausedUntil);
  const inServiceWindow = isInServiceWindow({
    last_customer_message_at: firstCustomer?.last_customer_message_at ?? null,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/dashboard/inbox"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to inbox
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {firstCustomer?.name || firstCustomer?.phone_e164 || "Conversation"}
        </h1>
        {firstCustomer?.name && firstCustomer.phone_e164 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {firstCustomer.phone_e164}
          </p>
        ) : null}
      </div>

      {paused && pausedUntil ? (
        <ThreadAiPauseBanner threadId={threadId} pausedUntil={pausedUntil} />
      ) : null}

      <ol className="space-y-3">
        {messages.map((row) => {
          const inbound = row.direction === "inbound";
          const parse = formatParse(row.ai_parse_result);
          return (
            <li
              key={row.id as string}
              className={cn("flex", inbound ? "justify-start" : "justify-end")}
            >
              <div
                className={cn(
                  "max-w-[85%] space-y-2 rounded-xl border px-4 py-3",
                  inbound ? "bg-card" : "bg-muted/50",
                )}
              >
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="font-medium">
                    {inbound ? "Buyer" : "Shop"}
                  </span>
                  <time>{formatDateTime(row.created_at as string)}</time>
                </div>
                <p className="whitespace-pre-wrap text-sm">
                  {(row.normalised_text as string | null)?.trim() || "(no text)"}
                </p>
                {isAiPausedSkip(row.ai_parse_result) ? (
                  <p className="text-xs font-medium text-amber-800">
                    Needs seller reply — AI paused
                  </p>
                ) : parse && (parse.intent || parse.confidence) ? (
                  <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs">
                    <p className="font-medium text-foreground">
                      Assistant classification
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {parse.intent ? `Intent: ${parse.intent}` : "Intent unknown"}
                      {parse.confidence ? ` · Confidence: ${parse.confidence}` : ""}
                      {parse.needsClarification ? " · Needs clarification" : ""}
                      {parse.escalateToSeller ? " · Escalated to seller" : ""}
                    </p>
                    {parse.items.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-muted-foreground">
                        {parse.items.map((item, index) => (
                          <li key={`${item.query}-${index}`}>
                            {item.quantity}× {item.query}
                            {item.variant ? ` (${item.variant})` : ""}
                            {item.matched
                              ? ` · matched (${Math.round(item.matchConfidence * 100)}%)`
                              : " · unmatched"}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {parse.clarification ? (
                      <p className="mt-2 text-muted-foreground">
                        Clarification: {parse.clarification}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <ThreadReplyForm threadId={threadId} inServiceWindow={inServiceWindow} />
    </div>
  );
}
