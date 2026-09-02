import type { SupabaseClient } from "@supabase/supabase-js";

import { DEFAULT_WEIGHT_GRAMS } from "@/lib/shippo/client";

export type NewProductVariant = {
  label: string | null;
  stock_quantity: number;
  low_stock_threshold: number;
  track_inventory: boolean;
  weight_grams: number;
};

export type NewProductInput = {
  businessId: string;
  name: string;
  description: string | null;
  price_pence: number;
  photo_url: string | null;
  active: boolean;
  variants: NewProductVariant[];
};

/**
 * Creates one product and its variants. Used by the dashboard form and
 * CSV import so both paths write the same shape of rows.
 *
 * If variant inserts fail after the product row exists, the product (and
 * any variants that did land) are deleted so we do not leave an
 * unorderable product in the catalogue.
 */
export async function createProductWithVariants(
  supabase: SupabaseClient,
  input: NewProductInput,
): Promise<{ productId: string }> {
  if (input.variants.length === 0) {
    throw new Error("A product needs at least one variant.");
  }

  const { data: inserted, error: insertError } = await supabase
    .from("products")
    .insert({
      business_id: input.businessId,
      name: input.name,
      description: input.description,
      price_pence: input.price_pence,
      photo_url: input.photo_url,
      active: input.active,
    })
    .select("id")
    .single();

  if (insertError) throw new Error(insertError.message);
  const productId = inserted.id as string;

  try {
    for (const variant of input.variants) {
      const weight =
        Number.isInteger(variant.weight_grams) && variant.weight_grams > 0
          ? variant.weight_grams
          : DEFAULT_WEIGHT_GRAMS;
      const { error: variantError } = await supabase
        .from("product_variants")
        .insert({
          product_id: productId,
          business_id: input.businessId,
          label: variant.label,
          stock_quantity: Math.max(0, variant.stock_quantity),
          reserved_quantity: 0,
          low_stock_threshold: Math.max(0, variant.low_stock_threshold),
          track_inventory: variant.track_inventory,
          weight_grams: weight,
        });
      if (variantError) throw new Error(variantError.message);
    }
  } catch (caught) {
    await supabase.from("product_images").delete().eq("product_id", productId);
    await supabase.from("product_variants").delete().eq("product_id", productId);
    await supabase.from("products").delete().eq("id", productId);
    throw caught;
  }

  return { productId };
}

/**
 * Creates many products. If any insert fails, previously created products
 * in this batch are deleted so the import stays all-or-nothing.
 */
export async function createCatalogProducts(
  supabase: SupabaseClient,
  products: NewProductInput[],
): Promise<{ productIds: string[] }> {
  const productIds: string[] = [];
  try {
    for (const product of products) {
      const created = await createProductWithVariants(supabase, product);
      productIds.push(created.productId);
    }
    return { productIds };
  } catch (caught) {
    for (const id of productIds.reverse()) {
      await supabase.from("product_images").delete().eq("product_id", id);
      await supabase.from("product_variants").delete().eq("product_id", id);
      await supabase.from("products").delete().eq("id", id);
    }
    throw caught;
  }
}
