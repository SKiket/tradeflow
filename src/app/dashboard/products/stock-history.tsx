"use client";

import { useState } from "react";

import {
  INVENTORY_HISTORY_PAGE_SIZE,
  type InventoryMovementRow,
} from "@/lib/inventory/movements";
import {
  formatMovementLine,
  inventoryCopy,
  type InventoryLang,
} from "@/lib/inventory/movements-copy";
import { cn } from "@/lib/utils";

export function StockHistorySection({
  productId,
  variants,
  initialByVariant,
  lang,
}: {
  productId: string;
  variants: { id: string; label: string | null }[];
  initialByVariant: Record<string, InventoryMovementRow[]>;
  lang: InventoryLang;
}) {
  const copy = inventoryCopy(lang);
  if (variants.length === 0) return null;

  return (
    <section className="space-y-4" data-tf-stock-history={productId}>
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{copy.title}</h2>
        <p className="text-xs text-muted-foreground">{copy.starts}</p>
      </div>
      {variants.map((variant) => (
        <VariantHistory
          key={variant.id}
          variantId={variant.id}
          label={variant.label?.trim() || "Default"}
          initial={initialByVariant[variant.id] ?? []}
          lang={lang}
        />
      ))}
    </section>
  );
}

function VariantHistory({
  variantId,
  label,
  initial,
  lang,
}: {
  variantId: string;
  label: string;
  initial: InventoryMovementRow[];
  lang: InventoryLang;
}) {
  const copy = inventoryCopy(lang);
  const [rows, setRows] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(
    initial.length >= INVENTORY_HISTORY_PAGE_SIZE,
  );

  async function loadMore() {
    if (loading || rows.length === 0) return;
    setLoading(true);
    try {
      const before = rows[rows.length - 1]?.createdAt;
      const response = await fetch(
        `/api/dashboard/inventory-movements?variantId=${encodeURIComponent(variantId)}&before=${encodeURIComponent(before ?? "")}`,
      );
      const json = (await response.json().catch(() => ({}))) as {
        rows?: InventoryMovementRow[];
        error?: string;
      };
      if (!response.ok) throw new Error(json.error ?? "Could not load");
      const next = json.rows ?? [];
      setRows((prev) => [...prev, ...next]);
      setHasMore(next.length >= INVENTORY_HISTORY_PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="rounded-xl border px-3 py-3"
      data-tf-stock-history-variant={variantId}
    >
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const line = formatMovementLine(row, lang);
            return (
              <li
                key={row.id}
                className="flex items-start justify-between gap-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium leading-snug">{line.reason}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {line.when}
                    <span className="mx-1.5 text-border">·</span>
                    {line.stockAfter}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 tabular-nums font-semibold",
                    row.change > 0
                      ? "text-emerald-700"
                      : row.change < 0
                        ? "text-rose-700"
                        : "text-muted-foreground",
                  )}
                >
                  {line.change}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loading}
          className="mt-2 w-full rounded-lg py-2 text-sm font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60"
        >
          {loading ? "…" : copy.loadMore}
        </button>
      ) : null}
    </div>
  );
}
