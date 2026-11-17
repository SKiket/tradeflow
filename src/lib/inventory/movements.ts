import type { SupabaseClient } from "@supabase/supabase-js";

export const INVENTORY_HISTORY_START_ISO = "2026-11-17T00:00:00.000Z";
export const INVENTORY_HISTORY_PAGE_SIZE = 20;

export type InventoryMovementReason =
  | "sale"
  | "restock_cancellation"
  | "restock_return"
  | "manual_adjustment"
  | "initial"
  | "other";

export type InventoryMovementRow = {
  id: string;
  variantId: string;
  change: number;
  stockAfter: number;
  reason: InventoryMovementReason;
  orderId: string | null;
  orderRef: string | null;
  createdAt: string;
};

export async function fetchVariantInventoryMovements(
  supabase: SupabaseClient,
  businessId: string,
  variantId: string,
  limit = INVENTORY_HISTORY_PAGE_SIZE,
  beforeIso?: string | null,
): Promise<{ rows: InventoryMovementRow[]; error: string | null; ms: number }> {
  const t0 = Date.now();
  let query = supabase
    .from("inventory_movements")
    .select(
      "id, variant_id, change, stock_after, reason, order_id, created_at, orders(order_ref)",
    )
    .eq("business_id", businessId)
    .eq("variant_id", variantId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (beforeIso) {
    query = query.lt("created_at", beforeIso);
  }

  const { data, error } = await query;
  if (error) {
    return { rows: [], error: error.message, ms: Date.now() - t0 };
  }

  const rows: InventoryMovementRow[] = (data ?? []).map((row) => {
    const orderRaw = row.orders as
      | { order_ref: string }
      | { order_ref: string }[]
      | null;
    const order = Array.isArray(orderRaw) ? (orderRaw[0] ?? null) : orderRaw;
    return {
      id: row.id as string,
      variantId: row.variant_id as string,
      change: row.change as number,
      stockAfter: row.stock_after as number,
      reason: row.reason as InventoryMovementReason,
      orderId: (row.order_id as string | null) ?? null,
      orderRef: order?.order_ref ?? null,
      createdAt: row.created_at as string,
    };
  });

  return { rows, error: null, ms: Date.now() - t0 };
}
