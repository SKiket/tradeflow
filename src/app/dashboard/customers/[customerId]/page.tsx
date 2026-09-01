import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { formatDateTime, formatPence } from "@/lib/orders/display";

import { OrdersTable, type OrderListRow } from "../../orders/orders-table";
import { requireSeller } from "../../require-seller";
import { CustomerProfileForm } from "./customer-profile-form";

interface CustomerDetailPageProps {
  params: Promise<{ customerId: string }>;
}

export default async function CustomerDetailPage({
  params,
}: CustomerDetailPageProps) {
  const { customerId } = await params;
  const { supabase } = await requireSeller();

  const { data: customer } = await supabase
    .from("customers")
    .select(
      "id, name, phone_e164, notes, tags, broadcast_opt_in, order_count, lifetime_value_pence, last_order_at",
    )
    .eq("id", customerId)
    .maybeSingle();

  if (!customer) notFound();

  const { data: orderRows, error: ordersError } = await supabase
    .from("orders")
    .select("id, order_ref, status, total_pence, created_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });

  const orders: OrderListRow[] = (orderRows ?? []).map((row) => ({
    id: row.id as string,
    order_ref: row.order_ref as string,
    status: row.status as string,
    total_pence: row.total_pence as number,
    created_at: row.created_at as string,
    customer_phone: customer.phone_e164 as string,
    customer_name: (customer.name as string | null) ?? null,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <Link
          href="/dashboard/customers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to customers
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {(customer.name as string | null) || (customer.phone_e164 as string)}
        </h1>
        {customer.name ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {customer.phone_e164 as string}
          </p>
        ) : null}
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border px-4 py-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Orders
            </dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {(customer.order_count as number) ?? 0}
            </dd>
          </div>
          <div className="rounded-xl border px-4 py-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Lifetime
            </dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {formatPence((customer.lifetime_value_pence as number) ?? 0)}
            </dd>
          </div>
          <div className="rounded-xl border px-4 py-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Last order
            </dt>
            <dd className="mt-1 text-lg font-semibold">
              {customer.last_order_at
                ? formatDateTime(customer.last_order_at as string)
                : "—"}
            </dd>
          </div>
        </dl>
      </div>

      <CustomerProfileForm
        customerId={customer.id as string}
        notes={(customer.notes as string | null) ?? ""}
        tags={Array.isArray(customer.tags) ? (customer.tags as string[]) : []}
        broadcastOptIn={customer.broadcast_opt_in !== false}
      />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Order history
        </h2>
        {ordersError ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t load orders. {ordersError.message}
          </p>
        ) : (
          <OrdersTable orders={orders} />
        )}
      </section>
    </div>
  );
}
