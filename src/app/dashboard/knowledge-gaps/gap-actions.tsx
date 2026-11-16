"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function KnowledgeGapActions({
  gapId,
  question,
  hasProduct,
}: {
  gapId: string;
  question: string;
  hasProduct: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [resolveTo, setResolveTo] = useState<"product_faq" | "shop_faq">(
    hasProduct ? "product_faq" : "shop_faq",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/knowledge-gaps/${gapId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Dismiss failed");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  async function saveAnswer() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/knowledge-gaps/${gapId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "answer",
          question,
          answer,
          resolveTo,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setOpen((v) => !v)}
        >
          Answer
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void dismiss()}
        >
          Dismiss
        </Button>
      </div>
      {open ? (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <Input value={question} readOnly className="text-sm" />
          <textarea
            className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Your answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            maxLength={500}
          />
          <div className="flex flex-wrap gap-3 text-sm">
            {hasProduct ? (
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={resolveTo === "product_faq"}
                  onChange={() => setResolveTo("product_faq")}
                />
                Save on product FAQ
              </label>
            ) : null}
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={resolveTo === "shop_faq"}
                onChange={() => setResolveTo("shop_faq")}
              />
              Save on shop FAQ
            </label>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={pending || !answer.trim()}
            onClick={() => void saveAnswer()}
          >
            Save FAQ
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
