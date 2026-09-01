import { Users } from "lucide-react";

import {
  compareCustomersByRecentActivity,
  EMPTY_CUSTOMER_LIFETIME,
  lifetimeByCustomerId,
} from "@/lib/customers/lifetime";
import { parseCustomerSegment } from "@/lib/customers/segments";

import { requireSeller } from "../require-seller";

import { CustomersTable, type CustomerListRow } from "./customers-table";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ segment?: string }>;
}) {
  const { segment: segmentParam } = await searchParams;
  const initialSegment = parseCustomerSegment(segmentParam);
  const { supabase } = await requireSeller();

  const [{ data, error }, { data: orderRows, error: ordersError }] =
    await Promise.all([
      supabase
        .from("customers")
        .select("id, name, phone_e164, tags, created_at"),
      supabase
        .from("orders")
        .select(
          "customer_id, status, total_pence, refunded_amount_pence, created_at",
        ),
    ]);

  if (error || ordersError) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Customers</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load customers. {(error ?? ordersError)?.message}
        </p>
      </div>
    );
  }

  const lifetime = lifetimeByCustomerId(
    (orderRows ?? []).map((row) => ({
      customer_id: (row.customer_id as string | null) ?? null,
      status: row.status as string,
      total_pence: (row.total_pence as number) ?? 0,
      refunded_amount_pence: (row.refunded_amount_pence as number | null) ?? 0,
      created_at: row.created_at as string,
    })),
  );

  const customers: CustomerListRow[] = (data ?? [])
    .map((row) => {
      const stats = lifetime.get(row.id as string) ?? EMPTY_CUSTOMER_LIFETIME;
      return {
        id: row.id as string,
        name: (row.name as string | null) ?? null,
        phone_e164: row.phone_e164 as string,
        order_count: stats.order_count,
        lifetime_value_pence: stats.lifetime_value_pence,
        last_order_at: stats.last_order_at,
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        created_at: (row.created_at as string | null) ?? null,
      };
    })
    .sort(compareCustomersByRecentActivity);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="tf-page-heading">Customers</h1>
        <p className="text-sm text-muted-foreground">
          {customers.length === 0
            ? "Buyers will appear here after they message you or place an order."
            : `${customers.length} customer${customers.length === 1 ? "" : "s"}, most recent activity first.`}
        </p>
      </div>
      {customers.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-16 text-center">
          <Users className="size-10 text-muted-foreground" />
          <h2 className="mt-4 text-lg font-semibold">No customers yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            When someone messages your shop or checks out, they&apos;ll show up
            here with their order history.
          </p>
        </div>
      ) : (
        <CustomersTable
          customers={customers}
          initialSegment={initialSegment}
        />
      )}
    </div>
  );
}
