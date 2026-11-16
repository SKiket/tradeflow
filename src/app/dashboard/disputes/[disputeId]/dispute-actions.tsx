"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function DisputeActions({
  disputeId,
  initialNotes,
  canEdit,
}: {
  disputeId: string;
  initialNotes: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  const [pending, setPending] = useState<"notes" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (!canEdit) {
    return (
      <div className="space-y-2 rounded-lg border p-4">
        <p className="text-sm text-muted-foreground">
          Evidence for this dispute has been submitted
          {initialNotes ? " (your notes were included)." : "."}
        </p>
        {initialNotes ? (
          <p className="whitespace-pre-wrap text-sm">{initialNotes}</p>
        ) : null}
      </div>
    );
  }

  async function saveNotes() {
    setError(null);
    setSuccess(null);
    setPending("notes");
    try {
      const response = await fetch(
        `/api/dashboard/disputes/${disputeId}/notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes }),
        },
      );
      const json = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(json.error ?? `Request failed (${response.status})`);
      }
      setSuccess("Notes saved and evidence pack updated.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  async function submitEvidence() {
    setError(null);
    setSuccess(null);
    setPending("submit");
    try {
      const response = await fetch(
        `/api/dashboard/disputes/${disputeId}/submit`,
        { method: "POST" },
      );
      const json = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(json.error ?? `Request failed (${response.status})`);
      }
      setSuccess("Evidence submitted to Stripe.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label htmlFor="dispute-notes">Your notes (optional)</Label>
        <textarea
          id="dispute-notes"
          className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add context Stripe should see — e.g. what the buyer said, how you resolved it."
          maxLength={8000}
        />
        <Button
          type="button"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void saveNotes()}
        >
          {pending === "notes" ? "Saving…" : "Save notes & refresh evidence"}
        </Button>
      </div>

      <div className="space-y-2 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          Submission is one-shot. Confirm only when you are ready — TradeFlow
          will also submit automatically 24 hours before the deadline if you
          have not.
        </p>
        <Button
          type="button"
          disabled={pending !== null}
          onClick={() => void submitEvidence()}
        >
          {pending === "submit" ? "Submitting…" : "Confirm and submit evidence"}
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {success ? <p className="text-sm text-emerald-700">{success}</p> : null}
    </div>
  );
}
