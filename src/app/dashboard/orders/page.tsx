import { fetchPaidOrderFacts } from "@/lib/analytics/paid-orders";
import { resolvePerformanceLang } from "@/lib/analytics/performance-copy";
import {
  rollingWindow,
} from "@/lib/analytics/performance-periods";
import { inWindow } from "@/lib/analytics/ranges";
import { totalsFor } from "@/lib/analytics/summarize";
import { getBusinessSellerLanguage } from "@/lib/channels/templates/business-language";
import { fetchSellerAttention } from "@/lib/dashboard/seller-attention";
import { resolveAttentionLang } from "@/lib/dashboard/seller-attention-copy";
import { unwrapRelation } from "@/lib/orders/display";

import { PerformanceHomeLink } from "../performance-home-link";
import { ShareHomeLink } from "../share-home-link";
import { SellerAttentionPanel } from "../seller-attention-panel";
import { requireSeller } from "../require-seller";
import { OrdersTable, type OrderListRow } from "./orders-table";

export default async function OrdersPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }>;
}) {
  const { supabase, businessId, business } = await requireSeller();
  const params = searchParams ? await searchParams : {};
  const initialStatus = params.status?.trim() || "ALL";

  const [ordersResult, attention, sellerLang, paidFacts] = await Promise.all([
    supabase
      .from("orders")
      .select(
        "id, order_ref, status, total_pence, created_at, customers(phone_e164, name)",
      )
      .eq("business_id", businessId)
      .order("created_at", { ascending: false }),
    fetchSellerAttention(supabase, {
      id: business.id,
      stripe_connected_account_id:
        (business.stripe_connected_account_id as string | null) ?? null,
      stripe_charges_enabled:
        (business.stripe_charges_enabled as boolean | null) ?? null,
      stripe_transfers_capability_active:
        (business.stripe_transfers_capability_active as boolean | null) ?? null,
    }),
    getBusinessSellerLanguage(supabase, businessId),
    fetchPaidOrderFacts(supabase, businessId),
  ]);

  const { data, error } = ordersResult;
  const lang = resolveAttentionLang(sellerLang);
  const perfLang = resolvePerformanceLang(sellerLang);
  const recentSales = totalsFor(
    paidFacts.facts.filter((row) =>
      inWindow(row.paidAt, rollingWindow(30)),
    ),
  ).revenuePence;

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
      <SellerAttentionPanel items={attention} lang={lang} />
      <div>
        <h1 className="tf-page-heading">Orders</h1>
        <p className="text-sm text-muted-foreground">
          {orders.length === 0
            ? "Your orders will appear here."
            : `${orders.length} order${orders.length === 1 ? "" : "s"}, newest first.`}
        </p>
        <PerformanceHomeLink salesPence={recentSales} lang={perfLang} />
        <ShareHomeLink lang={sellerLang} />
      </div>
      <OrdersTable orders={orders} initialStatus={initialStatus} />
    </div>
  );
}
