"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { SellerAttentionItem } from "@/lib/dashboard/seller-attention";
import {
  attentionUiCopy,
  formatAttentionRow,
  type AttentionLang,
} from "@/lib/dashboard/seller-attention-copy";

const MAX_VISIBLE = 5;

export function SellerAttentionPanel({
  items,
  lang,
}: {
  items: SellerAttentionItem[];
  lang: AttentionLang;
}) {
  const [expanded, setExpanded] = useState(false);
  const copy = attentionUiCopy(lang);

  if (items.length === 0) {
    return (
      <section
        aria-label={copy.title}
        className="rounded-xl border border-border/80 bg-muted/20 px-4 py-4"
        data-tf-attention="caught-up"
      >
        <p className="text-sm font-semibold text-foreground">{copy.allCaughtUp}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {copy.allCaughtUpBody}
        </p>
      </section>
    );
  }

  const visible = expanded ? items : items.slice(0, MAX_VISIBLE);
  const hasMore = items.length > MAX_VISIBLE;

  return (
    <section
      aria-label={copy.title}
      className="rounded-xl border border-amber-800/25 bg-amber-50/80 px-3 py-3 text-amber-950 sm:px-4"
      data-tf-attention="list"
      data-tf-attention-count={items.length}
    >
      <p className="px-1 text-sm font-semibold tracking-tight">{copy.title}</p>
      <ul className="mt-2 divide-y divide-amber-900/10">
        {visible.map((item) => {
          const row = formatAttentionRow(item, lang);
          return (
            <li key={item.kind}>
              <Link
                href={item.href}
                className="flex items-center gap-3 px-1 py-3 transition-colors hover:bg-amber-100/70 active:bg-amber-100"
                data-tf-attention-kind={item.kind}
                data-tf-attention-row-count={item.count}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-900 text-xs font-bold text-amber-50">
                  {item.count > 99 ? "99+" : item.count}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-snug">
                    {row.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-amber-900/75">
                    {row.reason}
                  </span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-amber-900/50"
                  aria-hidden
                />
              </Link>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <button
          type="button"
          className="mt-1 w-full rounded-lg px-2 py-2 text-center text-sm font-medium text-amber-950 underline-offset-2 hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? copy.showLess : copy.seeAll}
        </button>
      ) : null}
    </section>
  );
}
