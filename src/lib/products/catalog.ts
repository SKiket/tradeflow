import type { SupabaseClient } from "@supabase/supabase-js";

import { availableQuantity } from "@/lib/products/stock";

export interface CatalogVariant {
  id: string;
  label: string;
  stock_quantity: number;
  reserved_quantity: number;
  track_inventory: boolean;
  /** Sellable units when inventory is tracked; null when it is not. */
  available: number | null;
}

export interface CatalogProduct {
  id: string;
  name: string;
  description: string | null;
  price_pence: number;
  variants: CatalogVariant[];
}

/**
 * Active catalogue for a business: live products and non-deleted variants.
 * Shared by order_parse (matching) and support_reply (Q&A). One query.
 */
export async function fetchActiveCatalog(
  supabase: SupabaseClient,
  businessId: string,
): Promise<CatalogProduct[]> {
  const { data: products, error } = await supabase
    .from("products")
    .select(
      "id, name, description, price_pence, product_variants(id, label, stock_quantity, reserved_quantity, track_inventory, deleted_at)",
    )
    .eq("business_id", businessId)
    .eq("active", true)
    .is("deleted_at", null);

  if (error) {
    throw new Error(`catalog lookup failed: ${error.message}`);
  }

  return (products ?? []).map((product) => {
    const variants = (
      (product.product_variants as Array<{
        id: string;
        label: string;
        stock_quantity: number;
        reserved_quantity: number;
        track_inventory: boolean;
        deleted_at: string | null;
      }> | null) ?? []
    )
      .filter((variant) => !variant.deleted_at)
      .map((variant) => {
        const tracked = Boolean(variant.track_inventory);
        return {
          id: variant.id,
          label: variant.label,
          stock_quantity: variant.stock_quantity,
          reserved_quantity: variant.reserved_quantity ?? 0,
          track_inventory: tracked,
          available: tracked
            ? availableQuantity(
                variant.stock_quantity,
                variant.reserved_quantity,
              )
            : null,
        };
      });

    return {
      id: product.id as string,
      name: product.name as string,
      description: (product.description as string | null) ?? null,
      price_pence: product.price_pence as number,
      variants,
    };
  });
}
