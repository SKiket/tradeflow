import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsAppMessage } from "@/lib/channels/send/twilio-whatsapp";
import {
  availableQuantity,
  isVariantLowStock,
} from "@/lib/products/stock";

const ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;

interface VariantRow {
  id: string;
  business_id: string;
  label: string | null;
  stock_quantity: number;
  reserved_quantity: number;
  low_stock_threshold: number;
  track_inventory: boolean;
  low_stock_alerted_at: string | null;
  products: { name: string } | { name: string }[] | null;
}

export interface LowStockRunResult {
  businessesAlerted: number;
  variantsAlerted: number;
  variantsCleared: number;
  skipped: string[];
}

/**
 * Daily low-stock WhatsApp for sellers. One message per business.
 * Dedup via low_stock_alerted_at (null or older than ~20h). Restocked
 * variants have the timestamp cleared so a later dip alerts again.
 */
export async function runLowStockAlerts(
  supabase: SupabaseClient,
): Promise<LowStockRunResult> {
  const skipped: string[] = [];
  const { data: variants, error } = await supabase
    .from("product_variants")
    .select(
      "id, business_id, label, stock_quantity, reserved_quantity, low_stock_threshold, track_inventory, low_stock_alerted_at, products(name)",
    )
    .is("deleted_at", null);

  if (error) {
    throw new Error(`low-stock variant lookup failed: ${error.message}`);
  }

  const cutoffIso = new Date(Date.now() - ALERT_COOLDOWN_MS).toISOString();
  const claimedAt = new Date().toISOString();

  const toClear: string[] = [];
  const byBusiness = new Map<string, VariantRow[]>();

  for (const raw of variants ?? []) {
    const row = raw as VariantRow;
    const low = isVariantLowStock(row);
    if (!low) {
      if (row.low_stock_alerted_at) toClear.push(row.id);
      continue;
    }
    const alertedAt = row.low_stock_alerted_at;
    if (alertedAt && alertedAt >= cutoffIso) continue;
    const list = byBusiness.get(row.business_id) ?? [];
    list.push(row);
    byBusiness.set(row.business_id, list);
  }

  let variantsCleared = 0;
  if (toClear.length) {
    const { data: cleared, error: clearError } = await supabase
      .from("product_variants")
      .update({ low_stock_alerted_at: null })
      .in("id", toClear)
      .not("low_stock_alerted_at", "is", null)
      .select("id");
    if (clearError) {
      console.error("[low-stock] clear restocked variants failed", clearError.message);
    } else {
      variantsCleared = cleared?.length ?? 0;
    }
  }

  let businessesAlerted = 0;
  let variantsAlerted = 0;

  for (const [businessId, items] of byBusiness) {
    const claimed: VariantRow[] = [];
    for (const item of items) {
      const claimedRow = await claimVariant(supabase, item, claimedAt);
      if (claimedRow) claimed.push(item);
    }
    if (!claimed.length) continue;

    const { data: business } = await supabase
      .from("businesses")
      .select("id, seller_whatsapp_phone_e164")
      .eq("id", businessId)
      .is("deleted_at", null)
      .maybeSingle();

    const sellerPhone = business?.seller_whatsapp_phone_e164?.trim();
    if (!sellerPhone) {
      skipped.push(`no_seller_phone:${businessId}`);
      await unclaim(supabase, claimed, claimedAt);
      continue;
    }

    const text = buildAlertText(claimed);
    try {
      await sendWhatsAppMessage({
        businessId,
        toPhoneE164: sellerPhone,
        text,
        supabase,
      });
      businessesAlerted += 1;
      variantsAlerted += claimed.length;
      console.info("[low-stock] alert sent", {
        businessId,
        variantCount: claimed.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[low-stock] WhatsApp send failed — releasing claim", {
        businessId,
        error: message,
      });
      await unclaim(supabase, claimed, claimedAt);
      skipped.push(`send_failed:${businessId}`);
    }
  }

  return { businessesAlerted, variantsAlerted, variantsCleared, skipped };
}

async function claimVariant(
  supabase: SupabaseClient,
  item: VariantRow,
  claimedAt: string,
): Promise<boolean> {
  let query = supabase
    .from("product_variants")
    .update({ low_stock_alerted_at: claimedAt })
    .eq("id", item.id);
  query = item.low_stock_alerted_at
    ? query.eq("low_stock_alerted_at", item.low_stock_alerted_at)
    : query.is("low_stock_alerted_at", null);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    console.error("[low-stock] claim failed", {
      variantId: item.id,
      error: error.message,
    });
    return false;
  }
  return !!data;
}

async function unclaim(
  supabase: SupabaseClient,
  claimed: VariantRow[],
  claimedAt: string,
): Promise<void> {
  const ids = claimed.map((row) => row.id);
  if (!ids.length) return;
  await supabase
    .from("product_variants")
    .update({ low_stock_alerted_at: null })
    .in("id", ids)
    .eq("low_stock_alerted_at", claimedAt);
}

function productName(row: VariantRow): string {
  const raw = row.products;
  const product = Array.isArray(raw) ? raw[0] : raw;
  const name = product?.name ?? "Item";
  const label = row.label ? ` (${row.label})` : "";
  return `${name}${label}`;
}

function buildAlertText(items: VariantRow[]): string {
  const lines = items.map((item) => {
    const left = availableQuantity(item.stock_quantity, item.reserved_quantity);
    return `• ${productName(item)} — ${left} left (threshold ${item.low_stock_threshold})`;
  });
  return ["Low stock:", ...lines].join("\n");
}
