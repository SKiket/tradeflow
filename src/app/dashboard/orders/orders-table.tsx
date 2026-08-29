"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList } from "lucide-react";

import { StatusBadge } from "@/components/orders/status-badge";
import { Input } from "@/components/ui/input";
import {
  formatDateTime,
  formatPence,
  SELLER_STATUSES,
  statusLabel,
} from "@/lib/orders/display";

export type OrderListRow = {
  id: string;
  order_ref: string;
  status: string;
  total_pence: number;
  created_at: string;
  customer_phone: string | null;
  customer_name: string | null;
};

export function OrdersTable({ orders }: { orders: OrderListRow[] }) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((order) => {
      if (statusFilter !== "ALL" && order.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [
        order.order_ref,
        order.customer_phone ?? "",
        order.customer_name ?? "",
        statusLabel(order.status),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [orders, statusFilter, query]);

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-16 text-center">
        <ClipboardList className="size-10 text-muted-foreground" />
        <h2 className="mt-4 text-lg font-semibold">No orders yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          When customers place orders over WhatsApp, they&apos;ll show up here.
          You&apos;re all set — nothing to do until the first one comes in.
        </p>
      </div>
    );
  }

  function openOrder(id: string) {
    router.push(`/dashboard/orders/${id}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Search</span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Order ref or phone"
            aria-label="Search orders"
          />
        </label>
        <label className="flex w-full flex-col gap-1 text-sm sm:w-64">
          <span className="font-medium">Status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="Filter by status"
            className="flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="ALL">All statuses ({orders.length})</option>
            {SELLER_STATUSES.map((status) => {
              const count = orders.filter((order) => order.status === status).length;
              return (
                <option key={status} value={status}>
                  {statusLabel(status)} ({count})
                </option>
              );
            })}
          </select>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No orders match this filter.
        </p>
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            {filtered.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => openOrder(order.id)}
                className="flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold">
                    {order.order_ref}
                  </span>
                  <StatusBadge status={order.status} />
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{order.customer_phone ?? "—"}</span>
                  <span className="font-medium text-foreground">
                    {formatPence(order.total_pence)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(order.created_at)}
                </p>
              </button>
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Order</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((order) => (
                  <tr
                    key={order.id}
                    tabIndex={0}
                    className="cursor-pointer border-b last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                    onClick={() => openOrder(order.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openOrder(order.id);
                      }
                    }}
                  >
                    <td className="px-4 py-3 font-mono font-medium">
                      <Link
                        href={`/dashboard/orders/${order.id}`}
                        className="hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {order.order_ref}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={order.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {order.customer_phone ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatPence(order.total_pence)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(order.created_at)}
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
