"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AllergensStatus, FaqItem } from "@/lib/knowledge/types";

export type ProductKnowledgeDraft = {
  usageInstructions: string;
  ingredients: string;
  storageAndCare: string;
  sizeAndFit: string;
  allergensStatus: AllergensStatus;
  allergensText: string;
  faqs: FaqItem[];
};

export function blankKnowledgeDraft(): ProductKnowledgeDraft {
  return {
    usageInstructions: "",
    ingredients: "",
    storageAndCare: "",
    sizeAndFit: "",
    allergensStatus: "not_provided",
    allergensText: "",
    faqs: [],
  };
}

export function ProductKnowledgeFields({
  value,
  onChange,
  onSuggestFromPhoto,
  suggestPending,
  suggestError,
  suggestHint,
}: {
  value: ProductKnowledgeDraft;
  onChange: (next: ProductKnowledgeDraft) => void;
  onSuggestFromPhoto?: () => void;
  suggestPending?: boolean;
  suggestError?: string | null;
  suggestHint?: string | null;
}) {
  function updateFaq(index: number, patch: Partial<FaqItem>) {
    const faqs = value.faqs.map((item, i) =>
      i === index ? { ...item, ...patch } : item,
    );
    onChange({ ...value, faqs });
  }

  return (
    <section className="space-y-4 border-t pt-6">
      <div>
        <h2 className="text-base font-semibold">Product knowledge</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Plain text the AI can use to answer buyers. Leave blank if you do not
          want the AI to answer that topic.
        </p>
      </div>

      {onSuggestFromPhoto ? (
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={suggestPending}
              onClick={onSuggestFromPhoto}
            >
              {suggestPending ? "Suggesting…" : "Suggest from photo"}
            </Button>
            <span className="text-xs text-muted-foreground">
              AI suggestion: check before publishing
            </span>
          </div>
          {suggestError ? (
            <p className="text-sm text-destructive">{suggestError}</p>
          ) : null}
          {suggestHint ? (
            <p className="text-xs text-muted-foreground">{suggestHint}</p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="usage_instructions">How to use</Label>
        <p className="text-xs text-muted-foreground">
          Steps or tips buyers need to use the product.
        </p>
        <textarea
          id="usage_instructions"
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={value.usageInstructions}
          onChange={(e) =>
            onChange({ ...value, usageInstructions: e.target.value })
          }
          maxLength={2000}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="ingredients">Ingredients</Label>
        <p className="text-xs text-muted-foreground">
          Only list what you are happy for the AI to repeat.
        </p>
        <textarea
          id="ingredients"
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={value.ingredients}
          onChange={(e) => onChange({ ...value, ingredients: e.target.value })}
          maxLength={2000}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="storage_and_care">Storage and care</Label>
        <textarea
          id="storage_and_care"
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={value.storageAndCare}
          onChange={(e) =>
            onChange({ ...value, storageAndCare: e.target.value })
          }
          maxLength={2000}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="size_and_fit">Size and fit</Label>
        <textarea
          id="size_and_fit"
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={value.sizeAndFit}
          onChange={(e) => onChange({ ...value, sizeAndFit: e.target.value })}
          maxLength={2000}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Allergens</legend>
        <p className="text-xs text-muted-foreground">
          Default is Not provided — the AI will not invent allergen claims.
        </p>
        {(
          [
            ["not_provided", "Not provided"],
            ["none_declared", "I declare no allergens"],
            ["listed", "These allergens apply"],
          ] as const
        ).map(([status, label]) => (
          <label key={status} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="allergens_status"
              checked={value.allergensStatus === status}
              onChange={() =>
                onChange({ ...value, allergensStatus: status })
              }
            />
            {label}
          </label>
        ))}
        {value.allergensStatus === "listed" ? (
          <textarea
            className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="List allergens here"
            value={value.allergensText}
            onChange={(e) =>
              onChange({ ...value, allergensText: e.target.value })
            }
            maxLength={2000}
          />
        ) : null}
      </fieldset>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Label>Product FAQs</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={value.faqs.length >= 10}
            onClick={() =>
              onChange({
                ...value,
                faqs: [...value.faqs, { question: "", answer: "" }],
              })
            }
          >
            Add FAQ
          </Button>
        </div>
        {value.faqs.map((faq, index) => (
          <div key={index} className="space-y-2 rounded-md border p-3">
            <Input
              placeholder="Question"
              value={faq.question}
              maxLength={500}
              onChange={(e) => updateFaq(index, { question: e.target.value })}
            />
            <textarea
              className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Answer"
              value={faq.answer}
              maxLength={500}
              onChange={(e) => updateFaq(index, { answer: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange({
                  ...value,
                  faqs: value.faqs.filter((_, i) => i !== index),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
