"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTagInput, parseTagInput } from "@/lib/customers/segments";
import { createClient } from "@/lib/supabase/client";

export function CustomerProfileForm({
  customerId,
  notes,
  tags,
  broadcastOptIn,
}: {
  customerId: string;
  notes: string;
  tags: string[];
  broadcastOptIn: boolean;
}) {
  const router = useRouter();
  const [notesValue, setNotesValue] = useState(notes);
  const [tagsValue, setTagsValue] = useState(formatTagInput(tags));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("customers")
      .update({
        notes: notesValue.trim() || null,
        tags: parseTagInput(tagsValue),
      })
      .eq("id", customerId);

    setSaving(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSaved(true);
    router.refresh();
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Profile
      </h2>
      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border p-4">
        <div className="space-y-1.5">
          <Label htmlFor="customer-notes">Notes</Label>
          <textarea
            id="customer-notes"
            value={notesValue}
            onChange={(event) => setNotesValue(event.target.value)}
            rows={4}
            className="flex min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="customer-tags">Tags</Label>
          <Input
            id="customer-tags"
            value={tagsValue}
            onChange={(event) => setTagsValue(event.target.value)}
            placeholder="vip, wholesale, london"
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated. Used for your own filtering — not shown to buyers.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Broadcasts:{" "}
          <span className="font-medium text-foreground">
            {broadcastOptIn ? "Opted in" : "Opted out"}
          </span>. Read-only until broadcast sending exists.
        </p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {saved ? (
          <p className="text-sm text-muted-foreground">Saved.</p>
        ) : null}
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save notes and tags"}
        </Button>
      </form>
    </section>
  );
}
