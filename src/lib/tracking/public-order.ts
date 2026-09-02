import { cache } from "react";

import { parseAccentHex } from "@/lib/brand/accent";
import { unwrapRelation } from "@/lib/orders/display";
import type { OrderStatus } from "@/lib/orders/status";
import { createAdminClient } from "@/lib/supabase/admin";

import { carrierTrackingUrl } from "./carrier";

export const PUBLIC_ORDER_REF_RE = /^TF-[A-Za-z0-9-]{4,48}$/;

export type PublicTrackingItem = {
  productName: string;
  variantLabel: string | null;
  quantity: number;
};

export type PublicTrackingEvent = {
  status: string;
  at: string;
};

export type PublicTrackingShipment = {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelStatus: "issued" | null;
};

export type PublicTrackingOrder = {
  orderRef: string;
  status: OrderStatus;
  createdAt: string;
  totalPence: number;
  refundedAmountPence: number;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  items: PublicTrackingItem[];
  shipment: PublicTrackingShipment | null;
  history: PublicTrackingEvent[];
};

type VariantJoin = {
  label: string | null;
  products: { name: string } | { name: string }[] | null;
} | null;

/**
 * Public tracking payload for an order_ref.
 *
 * Service-role client; RLS is not loosened. Selects only buyer-safe columns.
 * Internal ids, customer contact, Stripe, Shippo ids, label PDFs, and
 * shipping address are read only when needed to join, then dropped.
 */
export const fetchPublicTrackingOrder = cache(
  async (orderRef: string): Promise<PublicTrackingOrder | null> => {
    const trimmed = decodeURIComponent(orderRef).trim();
    if (!PUBLIC_ORDER_REF_RE.test(trimmed)) return null;

    const supabase = createAdminClient();
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(
        "id, order_ref, status, created_at, total_pence, refunded_amount_pence, dispatch_carrier, dispatch_tracking_number, dispatch_label_url, businesses(name, logo_url, banner_url, storefront_accent_color)",
      )
      .eq("order_ref", trimmed)
      .is("deleted_at", null)
      .maybeSingle();

    if (orderError) {
      throw new Error(`tracking order lookup failed: ${orderError.message}`);
    }
    if (!order) return null;

    const orderId = order.id as string;

    const [{ data: itemRows, error: itemError }, { data: historyRows, error: historyError }] =
      await Promise.all([
        supabase
          .from("order_items")
          .select("quantity, product_variants(label, products(name))")
          .eq("order_id", orderId)
          .order("created_at", { ascending: true }),
        supabase
          .from("order_status_history")
          .select("to_status, changed_at")
          .eq("order_id", orderId)
          .order("changed_at", { ascending: true }),
      ]);

    if (itemError) {
      throw new Error(`tracking items lookup failed: ${itemError.message}`);
    }
    if (historyError) {
      throw new Error(`tracking history lookup failed: ${historyError.message}`);
    }

    const items: PublicTrackingItem[] = (itemRows ?? []).map((row) => {
      const variant = unwrapRelation(row.product_variants as VariantJoin | VariantJoin[]);
      const product = unwrapRelation(variant?.products);
      return {
        productName: product?.name ?? "Item",
        variantLabel: variant?.label ?? null,
        quantity: row.quantity as number,
      };
    });

    const history: PublicTrackingEvent[] = (historyRows ?? []).map((row) => ({
      status: row.to_status as string,
      at: row.changed_at as string,
    }));

    const carrier = (order.dispatch_carrier as string | null)?.trim() || null;
    const trackingNumber =
      (order.dispatch_tracking_number as string | null)?.trim() || null;
    const labelIssued = Boolean(
      (order.dispatch_label_url as string | null)?.trim(),
    );
    const shipment =
      carrier || trackingNumber || labelIssued
        ? {
            carrier,
            trackingNumber,
            trackingUrl: carrierTrackingUrl(carrier, trackingNumber),
            labelStatus: labelIssued ? ("issued" as const) : null,
          }
        : null;

    const business = unwrapRelation(
      order.businesses as
        | {
            name: string;
            logo_url: string | null;
            banner_url: string | null;
            storefront_accent_color: string | null;
          }
        | {
            name: string;
            logo_url: string | null;
            banner_url: string | null;
            storefront_accent_color: string | null;
          }[]
        | null,
    );

    return {
      orderRef: order.order_ref as string,
      status: order.status as OrderStatus,
      createdAt: order.created_at as string,
      totalPence: order.total_pence as number,
      refundedAmountPence: (order.refunded_amount_pence as number) ?? 0,
      businessName: business?.name ?? "Shop",
      logoUrl: business?.logo_url ?? null,
      bannerUrl: business?.banner_url ?? null,
      accentColor: parseAccentHex(business?.storefront_accent_color),
      items,
      shipment,
      history,
    };
  },
);

export type PublicReturnSlip = {
  orderRef: string;
  status: string;
  businessName: string;
  returnAddress: {
    line1: string | null;
    city: string | null;
    postcode: string | null;
  };
  items: PublicTrackingItem[];
};

export async function fetchPublicReturnSlip(
  orderRef: string,
): Promise<PublicReturnSlip | null> {
  const trimmed = decodeURIComponent(orderRef).trim();
  if (!PUBLIC_ORDER_REF_RE.test(trimmed)) return null;

  const supabase = createAdminClient();
  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, order_ref, status, businesses(name, dispatch_address_line1, dispatch_city, dispatch_postcode)",
    )
    .eq("order_ref", trimmed)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(`return slip lookup failed: ${error.message}`);
  }
  if (!order) return null;

  const { data: itemRows, error: itemError } = await supabase
    .from("order_items")
    .select("quantity, product_variants(label, products(name))")
    .eq("order_id", order.id as string)
    .order("created_at", { ascending: true });

  if (itemError) {
    throw new Error(`return slip items lookup failed: ${itemError.message}`);
  }

  const items: PublicTrackingItem[] = (itemRows ?? []).map((row) => {
    const variant = unwrapRelation(row.product_variants as VariantJoin | VariantJoin[]);
    const product = unwrapRelation(variant?.products);
    return {
      productName: product?.name ?? "Item",
      variantLabel: variant?.label ?? null,
      quantity: row.quantity as number,
    };
  });

  const business = unwrapRelation(
    order.businesses as
      | {
          name: string;
          dispatch_address_line1: string | null;
          dispatch_city: string | null;
          dispatch_postcode: string | null;
        }
      | {
          name: string;
          dispatch_address_line1: string | null;
          dispatch_city: string | null;
          dispatch_postcode: string | null;
        }[]
      | null,
  );

  return {
    orderRef: order.order_ref as string,
    status: order.status as string,
    businessName: business?.name ?? "Shop",
    returnAddress: {
      line1: business?.dispatch_address_line1?.trim() || null,
      city: business?.dispatch_city?.trim() || null,
      postcode: business?.dispatch_postcode?.trim() || null,
    },
    items,
  };
}
