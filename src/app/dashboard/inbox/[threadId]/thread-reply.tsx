"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/orders/display";

const OUTSIDE_WINDOW_MESSAGE =
  "This may not deliver: the customer hasn't messaged in the last 24 hours and free-form replies can fail outside that window";

function apiErrorMessage(json: unknown, status: number): string {
  if (json && typeof json === "object" && "error" in json) {
    const error = (json as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return `Request failed (${status})`;
}

export function ThreadReplyForm({
  threadId,
  inServiceWindow,
}: {
  threadId: string;
  inServiceWindow: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowWarning, setWindowWarning] = useState(!inServiceWindow);

  async function send(acknowledgeOutsideWindow: boolean) {
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/inbox/${threadId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          acknowledgeOutsideWindow,
        }),
      });
      const json = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (response.status === 409 && json.code === "OUTSIDE_SERVICE_WINDOW") {
        setWindowWarning(true);
        return;
      }
      if (!response.ok || json.ok === false) {
        throw new Error(apiErrorMessage(json, response.status));
      }
      setText("");
      setWindowWarning(!inServiceWindow);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || pending) return;
    void send(windowWarning);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border bg-card p-4">
      <label htmlFor="inbox-reply" className="text-sm font-medium">
        Reply
      </label>
      <textarea
        id="inbox-reply"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        required
        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        placeholder="Write a WhatsApp reply…"
      />
      {windowWarning ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {OUTSIDE_WINDOW_MESSAGE}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}
      <Button type="submit" disabled={pending || !text.trim()}>
        {pending
          ? "Sending…"
          : windowWarning
            ? "Send anyway"
            : "Send"}
      </Button>
    </form>
  );
}

export function ThreadAiPauseBanner({
  threadId,
  pausedUntil,
}: {
  threadId: string;
  pausedUntil: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/inbox/${threadId}/resume-ai`, {
        method: "POST",
      });
      const json = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok || json.ok === false) {
        throw new Error(apiErrorMessage(json, response.status));
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
      <p className="text-sm text-indigo-950">
        AI replies paused until {formatDateTime(pausedUntil)} — you&apos;re
        handling this conversation.
      </p>
      <div className="flex items-center gap-2">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void resume()}
        >
          {pending ? "Resuming…" : "Resume AI for this thread"}
        </Button>
      </div>
    </div>
  );
}
