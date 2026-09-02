import type { SupabaseClient } from "@supabase/supabase-js";

export const MAX_PRODUCT_IMAGES = 6;

export type ProductImageRow = {
  id: string;
  image_url: string;
  sort_order: number;
};

export function sortProductImages<T extends { sort_order: number }>(
  images: T[],
): T[] {
  return [...images].sort((a, b) => a.sort_order - b.sort_order);
}

export function coverImageUrl(imageUrls: string[]): string | null {
  return imageUrls[0]?.trim() || null;
}

/**
 * Replaces a product's gallery and lets the DB trigger sync products.photo_url
 * to the image at sort_order 0 (or NULL when empty).
 */
export async function replaceProductGallery(
  supabase: SupabaseClient,
  options: {
    productId: string;
    businessId: string;
    imageUrls: string[];
  },
): Promise<void> {
  const urls = options.imageUrls.map((url) => url.trim()).filter(Boolean);
  if (urls.length > MAX_PRODUCT_IMAGES) {
    throw new Error("A product can have at most 6 images.");
  }

  const { error: deleteError } = await supabase
    .from("product_images")
    .delete()
    .eq("product_id", options.productId);
  if (deleteError) throw new Error(deleteError.message);

  if (urls.length === 0) return;

  const { error: insertError } = await supabase.from("product_images").insert(
    urls.map((image_url, sort_order) => ({
      product_id: options.productId,
      business_id: options.businessId,
      image_url,
      sort_order,
    })),
  );
  if (insertError) throw new Error(insertError.message);
}
