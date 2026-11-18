"use client";

import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { assistUiCopy } from "@/lib/assist/copy";
import { hasOpenPlaceholders } from "@/lib/assist/placeholders";
import type { NewDetailHit } from "@/lib/assist/new-details";

export type AssistedContextType = "inbox" | "returns" | "disputes" | "order" | "product";

export type AssistedTextboxProps = {
  /** Where this box is used — Inbox first; later steps reuse. */
  contextType: AssistedContextType;
  /** Customer conversation language (en/fr/…). */
  customerLanguage: string | null;
  /** Seller UI language for button labels. */
  uiLang?: string | null;
  /** Show "Suggest a reply" more prominently when AI escalated / paused. */
  sellerNeeded?: boolean;
  value: string;
  onChange: (value: string) => void;
  /** Polish / draft endpoint for this context. */
  assistUrl: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /** When placeholders remain, parent should disable Send. */
  onBlockSendChange?: (blocked: boolean) => void;
};

type SuggestionState = {
  text: string;
  original: string;
  translationLabel: string | null;
  newDetails: NewDetailHit[];
  history: string[];
};

export function AssistedTextbox(props: AssistedTextboxProps) {
  const copy = assistUiCopy(props.uiLang);
  const [pending, setPending] = useState<"polish" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);

  const blocked = useMemo(
    () => hasOpenPlaceholders(props.value),
    [props.value],
  );

  const notifyBlock = useCallback(
    (next: string) => {
      props.onBlockSendChange?.(hasOpenPlaceholders(next));
    },
    [props],
  );

  const setValue = useCallback(
    (next: string) => {
      props.onChange(next);
      notifyBlock(next);
    },
    [props, notifyBlock],
  );

  async function runAssist(action: "polish" | "draft") {
    setError(null);
    setPending(action);
    try {
      const response = await fetch(props.assistUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          text: props.value,
          uiLang: props.uiLang ?? "en",
        }),
      });
      const json = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok && response.status !== 200) {
        throw new Error(
          typeof json.error === "string" ? json.error : `Request failed (${response.status})`,
        );
      }
      if (json.ok === false) {
        setError(
          typeof json.error === "string"
            ? json.error
            : "Couldn't assist right now.",
        );
        return;
      }
      const text =
        typeof json.suggestion === "string" ? json.suggestion : "";
      if (!text) {
        setError("Couldn't assist right now.");
        return;
      }
      setSuggestion({
        text,
        original:
          typeof json.original === "string" ? json.original : props.value,
        translationLabel:
          typeof json.translationLabel === "string"
            ? json.translationLabel
            : null,
        newDetails: Array.isArray(json.newDetails)
          ? (json.newDetails as NewDetailHit[])
          : [],
        history: suggestion ? [...suggestion.history, props.value] : [props.value],
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't assist right now. You can still send your message.",
      );
    } finally {
      setPending(null);
    }
  }

  function useSuggestion() {
    if (!suggestion) return;
    setValue(suggestion.text);
    setSuggestion(null);
  }

  function keepMine() {
    setSuggestion(null);
  }

  function undo() {
    if (!suggestion) return;
    const prev = suggestion.history[suggestion.history.length - 1];
    if (typeof prev === "string") setValue(prev);
    setSuggestion(null);
  }

  return (
    <div className="space-y-3" data-tf-assisted-textbox data-context={props.contextType}>
      <textarea
        id={props.id}
        value={props.value}
        onChange={(event) => setValue(event.target.value)}
        rows={props.rows ?? 3}
        disabled={props.disabled || Boolean(pending)}
        required
        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        placeholder={props.placeholder}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.disabled || Boolean(pending) || !props.value.trim()}
          onClick={() => void runAssist("polish")}
          data-tf-assist-polish
        >
          {pending === "polish" ? copy.pending : copy.polish}
        </Button>
        <Button
          type="button"
          variant={props.sellerNeeded ? "default" : "outline"}
          size="sm"
          disabled={props.disabled || Boolean(pending)}
          onClick={() => void runAssist("draft")}
          data-tf-assist-draft
        >
          {pending === "draft" ? copy.pending : copy.suggest}
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-muted-foreground" data-tf-assist-error>
          {error}
        </p>
      ) : null}

      {blocked ? (
        <p className="text-sm text-amber-800" data-tf-assist-placeholders>
          {copy.placeholderHint}
        </p>
      ) : null}

      {suggestion ? (
        <div
          className="space-y-2 rounded-lg border bg-muted/40 px-3 py-3"
          data-tf-assist-suggestion
        >
          {suggestion.translationLabel ? (
            <p className="text-xs font-medium text-muted-foreground">
              {suggestion.translationLabel}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap text-sm">{suggestion.text}</p>
          {suggestion.newDetails.length > 0 ? (
            <div
              className="rounded-md border border-amber-200 bg-amber-50 px-2 py-2 text-xs text-amber-950"
              data-tf-assist-new-details
            >
              <p className="font-medium">{copy.checkDetails}</p>
              <ul className="mt-1 list-disc pl-4">
                {suggestion.newDetails.map((hit, index) => (
                  <li key={`${hit.kind}-${hit.text}-${index}`}>
                    <mark className="bg-amber-200 px-0.5">{hit.text}</mark>
                    <span className="text-muted-foreground"> ({hit.kind})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={useSuggestion}>
              {copy.useIt}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={keepMine}>
              {copy.keepMine}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={undo}>
              {copy.undo}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
