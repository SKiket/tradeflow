"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type PreviewResult = {
  intent: string;
  confidence: number;
  needsClarification: boolean;
  clarificationMessage: string | null;
  escalateToSeller: boolean;
  matchedItems: Array<{
    product_query: string;
    variant_query: string | null;
    quantity: number;
    matched_product_id: string | null;
    matched_variant_id: string | null;
    match_confidence: number;
  }>;
  reply: string;
  orderPath: string | null;
};

function apiErrorMessage(json: unknown, status: number): string {
  if (json && typeof json === "object" && "error" in json) {
    const error = (json as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return `Request failed (${status})`;
}

export function InboxPreviewForm() {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setPending(true);
    try {
      const response = await fetch("/api/inbox/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const json = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok || json.ok === false) {
        throw new Error(apiErrorMessage(json, response.status));
      }
      setResult({
        intent: String(json.intent ?? ""),
        confidence: typeof json.confidence === "number" ? json.confidence : 0,
        needsClarification: json.needsClarification === true,
        clarificationMessage:
          typeof json.clarificationMessage === "string"
            ? json.clarificationMessage
            : null,
        escalateToSeller: json.escalateToSeller === true,
        matchedItems: Array.isArray(json.matchedItems)
          ? (json.matchedItems as PreviewResult["matchedItems"])
          : [],
        reply: typeof json.reply === "string" ? json.reply : "",
        orderPath: typeof json.orderPath === "string" ? json.orderPath : null,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border p-4">
        <div className="space-y-1">
          <Label htmlFor="preview-message">Sample buyer message</Label>
          <textarea
            id="preview-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={4}
            required
            disabled={pending}
            placeholder="e.g. I'd like a Classic Blue Mug"
            className="flex w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Running preview…" : "Preview reply"}
        </Button>
      </form>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {result && (
        <section className="space-y-3 rounded-xl border p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            What the assistant would do
          </h2>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Intent</dt>
              <dd className="font-medium">{result.intent}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Confidence</dt>
              <dd className="font-medium">
                {Math.round(result.confidence * 100)}%
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Needs clarification</dt>
              <dd className="font-medium">
                {result.needsClarification ? "Yes" : "No"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Escalate to seller</dt>
              <dd className="font-medium">
                {result.escalateToSeller ? "Yes" : "No"}
              </dd>
            </div>
            {result.orderPath ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Order path</dt>
                <dd className="font-medium">{result.orderPath}</dd>
              </div>
            ) : null}
          </dl>

          {result.matchedItems.length > 0 ? (
            <div>
              <p className="text-sm font-medium">Matched items</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {result.matchedItems.map((item, index) => (
                  <li key={`${item.product_query}-${index}`}>
                    {item.quantity}× {item.product_query}
                    {item.variant_query ? ` (${item.variant_query})` : ""}
                    {item.matched_product_id
                      ? ` — catalog match ${Math.round(item.match_confidence * 100)}%`
                      : " — no catalog match"}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No line items matched.</p>
          )}

          {result.clarificationMessage ? (
            <p className="text-sm text-muted-foreground">
              Clarification: {result.clarificationMessage}
            </p>
          ) : null}

          <div>
            <p className="text-sm font-medium">Reply that would be sent</p>
            <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-3 text-sm">
              {result.reply}
            </pre>
          </div>
        </section>
      )}
    </div>
  );
}
