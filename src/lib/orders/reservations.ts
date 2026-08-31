import type { SupabaseClient } from "@supabase/supabase-js";

import { ORDER_STATUS } from "@/lib/orders/status";

/**
 * Unpaid hold window. Matches Stripe Checkout's maximum `expires_at` (24h)
 * and spec Section 12 payment_chase (12h/23h reminders, 24h auto-cancel).
 *
 * Stripe rejects expires_at more than 24h from session creation, so the
 * unix helper subtracts 60s of clock-skew margin. reserved_until uses the
 * same instant so the local hold and the Checkout Session die together.
 */
export const RESERVATION_HOURS = 24;
const RESERVATION_SKEW_SECONDS = 60;
export const RESERVATION_SECONDS =
  RESERVATION_HOURS * 60 * 60 - RESERVATION_SKEW_SECONDS;

export function reservationExpiryUnix(fromMs = Date.now()): number {
  return Math.floor(fromMs / 1000) + RESERVATION_SECONDS;
}

export function reservationExpiryDate(fromMs = Date.now()): Date {
  return new Date(reservationExpiryUnix(fromMs) * 1000);
}

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
 * Keys off reserved_until, not a hardcoded duration — safe after the
 * 30-minute → 24-hour window change. Known gap: no scheduled cron;
 * relies on opportunistic calls during confirmation flows.
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

/**
 * Decrement reserved_quantity for all items on an order and set final status.
 *
 * The status write is compare-and-swap on the current status so two callers
 * (cron + buyer cancel, or overlapping cron ticks) cannot both release stock.
 * Returns true when this invocation won the race and performed the release.
 */
export async function releaseOrderReservation(
  supabase: SupabaseClient,
  orderId: string,
  finalStatus:
    | typeof ORDER_STATUS.EXPIRED
    | typeof ORDER_STATUS.PAYMENT_FAILED
    | typeof ORDER_STATUS.CANCELLED,
): Promise<boolean> {
  const { data: order } = await supabase
    .from("orders")
    .select("id, business_id, status")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) return false;
  if (
    order.status !== ORDER_STATUS.AWAITING_PAYMENT &&
    order.status !== ORDER_STATUS.PENDING_CONFIRMATION
  ) {
    return false;
  }

  const { data: claimed } = await supabase
    .from("orders")
    .update({
      status: finalStatus,
      reserved_until: null,
    })
    .eq("id", orderId)
    .eq("status", order.status)
    .select("id")
    .maybeSingle();

  if (!claimed) {
    return false;
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

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: order.business_id,
    from_status: order.status,
    to_status: finalStatus,
  });

  return true;
}

export interface StockCheckResult {
  ok: boolean;
  shortages: Array<{
    variantId: string;
    requested: number;
    available: number;
  }>;
}

export async function checkLinesStockAvailable(
  supabase: SupabaseClient,
  lines: Array<{ variantId: string; quantity: number }>,
): Promise<StockCheckResult> {
  const shortages: StockCheckResult["shortages"] = [];

  for (const line of lines) {
    const { data: variant } = await supabase
      .from("product_variants")
      .select("id, stock_quantity, reserved_quantity, track_inventory")
      .eq("id", line.variantId)
      .maybeSingle();

    if (!variant?.track_inventory) continue;

    const available = Math.max(
      0,
      (variant.stock_quantity ?? 0) - (variant.reserved_quantity ?? 0),
    );
    if (available < line.quantity) {
      shortages.push({
        variantId: variant.id,
        requested: line.quantity,
        available,
      });
    }
  }

  return { ok: shortages.length === 0, shortages };
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

  return checkLinesStockAvailable(
    supabase,
    (items ?? []).map((item) => ({
      variantId: item.product_variant_id as string,
      quantity: item.quantity as number,
    })),
  );
}

export async function incrementReservedQuantities(
  supabase: SupabaseClient,
  lines: Array<{ variantId: string; quantity: number }>,
): Promise<void> {
  for (const line of lines) {
    const { data: variant } = await supabase
      .from("product_variants")
      .select("id, reserved_quantity, track_inventory")
      .eq("id", line.variantId)
      .maybeSingle();

    if (!variant?.track_inventory) continue;

    await supabase
      .from("product_variants")
      .update({
        reserved_quantity: (variant.reserved_quantity ?? 0) + line.quantity,
      })
      .eq("id", variant.id);
  }
}

/** Increment reserved_quantity and set order.reserved_until + AWAITING_PAYMENT. */
export async function reserveOrderStock(
  supabase: SupabaseClient,
  orderId: string,
  businessId: string,
  reservedUntil?: Date,
): Promise<void> {
  const reservedUntilIso = (
    reservedUntil ?? reservationExpiryDate()
  ).toISOString();

  const { data: items } = await supabase
    .from("order_items")
    .select("quantity, product_variant_id")
    .eq("order_id", orderId);

  await incrementReservedQuantities(
    supabase,
    (items ?? []).map((item) => ({
      variantId: item.product_variant_id as string,
      quantity: item.quantity as number,
    })),
  );

  const { data: order } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .single();

  await supabase
    .from("orders")
    .update({
      status: ORDER_STATUS.AWAITING_PAYMENT,
      reserved_until: reservedUntilIso,
    })
    .eq("id", orderId);

  await supabase.from("order_status_history").insert({
    order_id: orderId,
    business_id: businessId,
    from_status: order?.status ?? ORDER_STATUS.PENDING_CONFIRMATION,
    to_status: ORDER_STATUS.AWAITING_PAYMENT,
  });
}
