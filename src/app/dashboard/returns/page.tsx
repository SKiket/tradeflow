import Link from "next/link";

import { getBusinessSellerLanguage } from "@/lib/channels/templates/business-language";
import { formatPence } from "@/lib/orders/display";
import {
  fetchReturnsList,
  parseReturnsPage,
  parseReturnsTab,
  RETURNS_TABS,
  type ReturnsTab,
} from "@/lib/returns/list-returns";
import {
  formatRequestedDate,
  formatReturnReasonLabel,
  formatWaited,
  refundStatusLabel,
  resolveReturnsLang,
  returnsCopy,
} from "@/lib/returns/returns-copy";
import { cn } from "@/lib/utils";

import { requireSeller } from "../require-seller";

export default async function ReturnsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string; page?: string }>;
}) {
  const { supabase, businessId } = await requireSeller();
  const params = searchParams ? await searchParams : {};
  const tab = parseReturnsTab(params.tab);
  const page = parseReturnsPage(params.page);

  const [list, sellerLang] = await Promise.all([
    fetchReturnsList(supabase, businessId, tab, page),
    getBusinessSellerLanguage(supabase, businessId),
  ]);
  const lang = resolveReturnsLang(sellerLang);
  const copy = returnsCopy(lang);
  const totalPages = Math.max(1, Math.ceil(list.total / list.pageSize));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="tf-page-heading">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
      </div>

      <div
        role="tablist"
        aria-label={copy.title}
        className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/30 p-0.5"
      >
        {RETURNS_TABS.map((id) => {
          const active = tab === id;
          const count = list.totals[id];
          return (
            <Link
              key={id}
              href={`/dashboard/returns?tab=${id}`}
              role="tab"
              aria-selected={active}
              className={cn(
                "shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              data-tf-returns-tab={id}
              data-tf-returns-tab-count={count}
            >
              {copy.tabs[id]}
              <span className="ml-1.5 tabular-nums text-muted-foreground">
                {count}
              </span>
            </Link>
          );
        })}
      </div>

      {list.error ? (
        <p className="text-sm text-destructive">
          Couldn&apos;t load returns. {list.error}
        </p>
      ) : list.rows.length === 0 ? (
        <section
          className="rounded-xl border border-border/80 bg-muted/20 px-4 py-8 text-center"
          data-tf-returns="empty"
        >
          <p className="text-sm font-semibold text-foreground">
            {copy.empty[tab]}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{copy.emptyBody}</p>
        </section>
      ) : (
        <ul className="divide-y divide-border rounded-xl border" data-tf-returns="list">
          {list.rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/dashboard/orders/${row.id}`}
                className="block px-4 py-3 transition-colors hover:bg-muted/40 active:bg-muted/60"
                data-tf-returns-row={row.orderRef}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold tracking-tight">
                      {row.orderRef}
                      {row.customerInitials ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {row.customerInitials}
                        </span>
                      ) : null}
                      {row.returnRestocked === false ? (
                        <span
                          className="ml-2 align-middle text-[11px] font-normal text-muted-foreground"
                          data-tf-returns-not-restocked
                        >
                          {copy.notRestocked}
                        </span>
                      ) : null}
                    </p>
                    {row.itemSummary ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {copy.items}: {row.itemSummary}
                      </p>
                    ) : null}
                    <p className="mt-1 text-sm leading-snug text-foreground/90">
                      {formatReturnReasonLabel(
                        row.returnReason,
                        row.returnReasonDetail,
                        lang,
                      )}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <p>{formatRequestedDate(row.returnRequestedAt, lang)}</p>
                    <p className="mt-0.5 font-medium text-foreground/80">
                      {formatWaited(row.returnRequestedAt, lang)}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {refundStatusLabel(row.refundStatus, lang)}
                  {row.refundStatus !== "none" ? (
                    <span className="ml-1 font-medium text-foreground tabular-nums">
                      {formatPence(row.refundedPence)}
                    </span>
                  ) : null}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {list.total > list.pageSize ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <PaginationLink
            tab={tab}
            page={page - 1}
            disabled={page <= 1}
            label={copy.prev}
          />
          <p className="text-muted-foreground">
            {copy.pageOf(page, totalPages)}
          </p>
          <PaginationLink
            tab={tab}
            page={page + 1}
            disabled={page >= totalPages}
            label={copy.next}
          />
        </div>
      ) : null}
    </div>
  );
}

function PaginationLink({
  tab,
  page,
  disabled,
  label,
}: {
  tab: ReturnsTab;
  page: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="px-2 py-1 text-muted-foreground/50">{label}</span>
    );
  }
  return (
    <Link
      href={`/dashboard/returns?tab=${tab}&page=${page}`}
      className="rounded-md px-2 py-1 font-medium underline-offset-2 hover:underline"
    >
      {label}
    </Link>
  );
}
