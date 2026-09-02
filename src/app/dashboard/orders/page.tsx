import { requireSeller } from "../require-seller";
import { unwrapRelation } from "@/lib/orders/display";

import { OrdersTable, type OrderListRow } from "./orders-table";

export default async function OrdersPage() {
  const { supabase, businessId } = await requireSeller();
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, order_ref, status, total_pence, created_at, customers(phone_e164, name)",
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Orders</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load orders. {error.message}
        </p>
      </div>
    );
  }

  const orders: OrderListRow[] = (data ?? []).map((row) => {
    const customer = unwrapRelation(
      row.customers as
        | { phone_e164: string; name: string | null }
        | { phone_e164: string; name: string | null }[]
        | null,
    );
    return {
      id: row.id as string,
      order_ref: row.order_ref as string,
      status: row.status as string,
      total_pence: row.total_pence as number,
      created_at: row.created_at as string,
      customer_phone: customer?.phone_e164 ?? null,
      customer_name: customer?.name ?? null,
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="tf-page-heading">Orders</h1>
        <p className="text-sm text-muted-foreground">
          {orders.length === 0
            ? "Your orders will appear here."
            : `${orders.length} order${orders.length === 1 ? "" : "s"}, newest first.`}
        </p>
      </div>
      <OrdersTable orders={orders} />
    </div>
  );
}
