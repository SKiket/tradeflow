"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Input } from "@/components/ui/input";
import {
  CUSTOMER_SEGMENTS,
  customerMatchesSegment,
  type CustomerSegment,
} from "@/lib/customers/segments";
import { formatDateTime, formatPence } from "@/lib/orders/display";

export type CustomerListRow = {
  id: string;
  name: string | null;
  phone_e164: string;
  order_count: number;
  lifetime_value_pence: number;
  last_order_at: string | null;
  tags: string[];
};

const SEGMENT_LABEL: Record<CustomerSegment, string> = {
  all: "All",
  new: "New",
  repeat: "Repeat",
  lapsed: "Lapsed",
};

export function CustomersTable({
  customers,
  initialSegment,
}: {
  customers: CustomerListRow[];
  initialSegment: CustomerSegment;
}) {
  const router = useRouter();
  const [segment, setSegment] = useState<CustomerSegment>(initialSegment);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return customers.filter((customer) => {
      if (!customerMatchesSegment(customer, segment)) return false;
      if (!q) return true;
      const haystack = [
        customer.name ?? "",
        customer.phone_e164,
        ...(customer.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [customers, segment, query]);

  function openCustomer(id: string) {
    router.push(`/dashboard/customers/${id}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Search</span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, phone, or tag"
            aria-label="Search customers"
          />
        </label>
        <label className="flex w-full flex-col gap-1 text-sm sm:w-64">
          <span className="font-medium">Segment</span>
          <select
            value={segment}
            onChange={(event) =>
              setSegment(event.target.value as CustomerSegment)
            }
            aria-label="Filter by segment"
            className="flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {CUSTOMER_SEGMENTS.map((value) => {
              const count = customers.filter((customer) =>
                customerMatchesSegment(customer, value),
              ).length;
              return (
                <option key={value} value={value}>
                  {SEGMENT_LABEL[value]} ({count})
                </option>
              );
            })}
          </select>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No customers match this filter.
        </p>
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            {filtered.map((customer) => (
              <button
                key={customer.id}
                type="button"
                onClick={() => openCustomer(customer.id)}
                className="flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">
                    {customer.name || customer.phone_e164}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {formatPence(customer.lifetime_value_pence)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{customer.phone_e164}</span>
                  <span>
                    {customer.order_count} order
                    {customer.order_count === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {customer.last_order_at
                    ? `Last order ${formatDateTime(customer.last_order_at)}`
                    : "No paid orders yet"}
                </p>
                {customer.tags.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {customer.tags.join(", ")}
                  </p>
                ) : null}
              </button>
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3 text-right">Orders</th>
                  <th className="px-4 py-3 text-right">Lifetime</th>
                  <th className="px-4 py-3">Last order</th>
                  <th className="px-4 py-3">Tags</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((customer) => (
                  <tr
                    key={customer.id}
                    tabIndex={0}
                    className="cursor-pointer border-b last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                    onClick={() => openCustomer(customer.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openCustomer(customer.id);
                      }
                    }}
                  >
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/dashboard/customers/${customer.id}`}
                        className="hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {customer.name || customer.phone_e164}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {customer.phone_e164}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {customer.order_count}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatPence(customer.lifetime_value_pence)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {customer.last_order_at
                        ? formatDateTime(customer.last_order_at)
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {customer.tags.length > 0 ? customer.tags.join(", ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
