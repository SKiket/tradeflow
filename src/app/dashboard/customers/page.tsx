import { Users } from "lucide-react";

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

  const { data, error } = await supabase
    .from("customers")
    .select(
      "id, name, phone_e164, order_count, lifetime_value_pence, last_order_at, tags",
    )
    .order("last_order_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Customers</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load customers. {error.message}
        </p>
      </div>
    );
  }

  const customers: CustomerListRow[] = (data ?? []).map((row) => ({
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    phone_e164: row.phone_e164 as string,
    order_count: (row.order_count as number) ?? 0,
    lifetime_value_pence: (row.lifetime_value_pence as number) ?? 0,
    last_order_at: (row.last_order_at as string | null) ?? null,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
  }));

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
