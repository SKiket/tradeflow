import type { SupabaseClient } from "@supabase/supabase-js";

import { CSV_COLUMNS } from "@/lib/products/csv-import";

type VariantRow = {
  label: string | null;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
  track_inventory: boolean | null;
  weight_grams: number | null;
  deleted_at: string | null;
};

type ProductRow = {
  name: string;
  description: string | null;
  price_pence: number;
  photo_url: string | null;
  active: boolean;
  product_variants: VariantRow[] | VariantRow | null;
};

/** Neutralise spreadsheet formula injection (=, +, -, @ at cell start). */
export function neutraliseCsvCell(value: string): string {
  if (/^[=+\-@]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

export function escapeCsvField(raw: string): string {
  const value = neutraliseCsvCell(raw);
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatPriceGbp(pence: number): string {
  return (pence / 100).toFixed(2);
}

function formatActive(active: boolean): string {
  return active ? "yes" : "no";
}

/**
 * Build catalogue CSV matching the importer columns/format.
 * One row per variant; products with no live variants are skipped.
 */
export function buildCatalogCsv(products: ProductRow[]): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];

  for (const product of products) {
    const variantsRaw = product.product_variants;
    const variants = (
      Array.isArray(variantsRaw)
        ? variantsRaw
        : variantsRaw
          ? [variantsRaw]
          : []
    ).filter((v) => !v.deleted_at);

    if (variants.length === 0) continue;

    for (const variant of variants) {
      const track = variant.track_inventory !== false;
      const stock =
        track && variant.stock_quantity != null
          ? String(variant.stock_quantity)
          : "";
      const threshold =
        variant.low_stock_threshold != null
          ? String(variant.low_stock_threshold)
          : "";
      const weight =
        variant.weight_grams != null ? String(variant.weight_grams) : "";
      const label = variant.label?.trim() ?? "";

      const cells = [
        product.name,
        product.description ?? "",
        formatPriceGbp(product.price_pence),
        product.photo_url ?? "",
        formatActive(product.active),
        label,
        stock,
        threshold,
        weight,
      ].map((cell) => escapeCsvField(cell));

      lines.push(cells.join(","));
    }
  }

  // UTF-8 BOM for Excel accent/£ display.
  return `\uFEFF${lines.join("\n")}\n`;
}

export function catalogExportFilename(slug: string, now = new Date()): string {
  const safe =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "shop";
  const date = now.toISOString().slice(0, 10);
  return `products-${safe}-${date}.csv`;
}

/** Load active-business catalogue via the caller's RLS-scoped client. */
export async function loadCatalogForExport(
  supabase: SupabaseClient,
  businessId: string,
): Promise<ProductRow[]> {
  const { data, error } = await supabase
    .from("products")
    .select(
      "name, description, price_pence, photo_url, active, product_variants(label, stock_quantity, low_stock_threshold, track_inventory, weight_grams, deleted_at)",
    )
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("name", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ProductRow[];
}
