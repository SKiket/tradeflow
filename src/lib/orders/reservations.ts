import type { SupabaseClient } from "@supabase/supabase-js";

import { ORDER_STATUS } from "@/lib/orders/status";

export const RESERVATION_MINUTES = 30;

interface OrderItemRow {
  id: string;
  quantity: number;
  product_variant_id: string;
}

interface VariantRow {
  id: string;
  stock_quantity: number;
  reserved_quantity: number;
  track_inventory: boolean;
}

/**
 * Lazy sweep: release expired holds for THIS business only.
 *
 * Known gap: no scheduled cron — relies on opportunistic calls during
 * confirmation flows. A real scheduled cleanup job is future work.
 */
export async function sweepExpiredReservations(
  supabase: SupabaseClient,
  businessId: string,
): Promise<number> {
  const now = new Date().toISOString();

  const { data: expired, error } = await supabase
    .from("orders")
    .select("id")
    .eq("business_id", businessId)
    .eq("status", ORDER_STATUS.AWAITING_PAYMENT)
    .lt("reserved_until", now)
    .is("deleted_at", null);

  if (error) {
    console.error("[reservations] sweep lookup failed", error.message);
    return 0;
  }

  let count = 0;
  for (const order of expired ?? []) {
    await releaseOrderReservation(supabase, order.id, ORDER_STATUS.EXPIRED);
    count += 1;
  }
  return count;
}

/** Decrement reserved_quantity for all items on an order and set final status. */
export async function releaseOrderReservation(
  supabase: SupabaseClient,
  orderId: string,
  finalStatus: typeof ORDER_STATUS.EXPIRED | typeof ORDER_STATUS.PAYMENT_FAILED,
): Promise<void> {
  const { data: order } = await supabase
    .from("orders")
    .select("id, business_id, status")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) return;
  if (
    order.status !== ORDER_STATUS.AWAITING_PAYMENT &&
    order.status !== ORDER_STATUS.PENDING_CONFIRMATION
  ) {
    return;
  }

  const { data: items } = await supabase
    .from("order_items")
    .select("id, quantity, product_variant_id")
    .eq("order_id", orderId);

  for (const item of (items as OrderItemRow[] | null) ?? []) {
    const { data: variant } = await supabase
      .from("product_variants")
      .select("id, reserved_quantity, track_inventory")
      .eq("id", item.product_variant_id)
      .maybeSingle();

    if (!variant?.track_inventory) continue;

    const nextReserved = Math.max(
      0,
      (variant.reserved_quantity ?? 0) - item.quantity,
    );
    await supabase
      .from("product_variants")
      .update({ reserved_quantity: nextReserved })
      .eq("id", variant.id);
  }

  await supabase
    .from("orders")
    .update({
      status: finalStatus,
      reserved_until: null,
    })
    .eq("id", orderId);

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: order.business_id,
    from_status: order.status,
    to_status: finalStatus,
  });
}

export interface StockCheckResult {
  ok: boolean;
  shortages: Array<{
    variantId: string;
    requested: number;
    available: number;
  }>;
}

/** Re-check availability accounting for current reservations (race protection). */
export async function checkOrderStockAvailable(
  supabase: SupabaseClient,
  orderId: string,
): Promise<StockCheckResult> {
  const { data: items } = await supabase
    .from("order_items")
    .select("quantity, product_variant_id")
    .eq("order_id", orderId);

  const shortages: StockCheckResult["shortages"] = [];

  for (const item of items ?? []) {
    const { data: variant } = await supabase
      .from("product_variants")
      .select("id, stock_quantity, reserved_quantity, track_inventory")
      .eq("id", item.product_variant_id)
      .maybeSingle();

    if (!variant?.track_inventory) continue;

    const available = Math.max(
      0,
      (variant.stock_quantity ?? 0) - (variant.reserved_quantity ?? 0),
    );
    if (available < item.quantity) {
      shortages.push({
        variantId: variant.id,
        requested: item.quantity,
        available,
      });
    }
  }

  return { ok: shortages.length === 0, shortages };
}

/** Increment reserved_quantity and set order.reserved_until + AWAITING_PAYMENT. */
export async function reserveOrderStock(
  supabase: SupabaseClient,
  orderId: string,
  businessId: string,
): Promise<void> {
  const reservedUntil = new Date(
    Date.now() + RESERVATION_MINUTES * 60 * 1000,
  ).toISOString();

  const { data: items } = await supabase
    .from("order_items")
    .select("quantity, product_variant_id")
    .eq("order_id", orderId);

  for (const item of items ?? []) {
    const { data: variant } = await supabase
      .from("product_variants")
      .select("id, reserved_quantity, track_inventory")
      .eq("id", item.product_variant_id)
      .maybeSingle();

    if (!variant?.track_inventory) continue;

    await supabase
      .from("product_variants")
      .update({
        reserved_quantity: (variant.reserved_quantity ?? 0) + item.quantity,
      })
      .eq("id", variant.id);
  }

  const { data: order } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .single();

  await supabase
    .from("orders")
    .update({
      status: ORDER_STATUS.AWAITING_PAYMENT,
      reserved_until: reservedUntil,
    })
    .eq("id", orderId);

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: businessId,
    from_status: order?.status ?? ORDER_STATUS.PENDING_CONFIRMATION,
    to_status: ORDER_STATUS.AWAITING_PAYMENT,
  });
}
