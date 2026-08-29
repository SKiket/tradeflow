import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { ProductForm, type ProductFormValues } from "../product-form";
import { requireSeller } from "../require-seller";

interface EditProductPageProps {
  params: Promise<{ productId: string }>;
}

export default async function EditProductPage({ params }: EditProductPageProps) {
  const { productId } = await params;
  const { supabase, businessId } = await requireSeller();

  const { data: product } = await supabase
    .from("products")
    .select(
      "id, name, description, price_pence, photo_url, active, product_variants(id, label, stock_quantity, low_stock_threshold, track_inventory)",
    )
    .eq("id", productId)
    .maybeSingle();

  if (!product) notFound();

  const variants = Array.isArray(product.product_variants)
    ? product.product_variants
    : product.product_variants
      ? [product.product_variants]
      : [];

  const values: ProductFormValues = {
    id: product.id as string,
    name: product.name as string,
    description: (product.description as string | null) ?? null,
    price_pence: product.price_pence as number,
    photo_url: (product.photo_url as string | null) ?? null,
    active: product.active as boolean,
    variants: variants.map((variant) => ({
      id: variant.id as string,
      label: (variant.label as string | null) ?? null,
      stock_quantity: variant.stock_quantity as number,
      low_stock_threshold: variant.low_stock_threshold as number,
      track_inventory: variant.track_inventory as boolean,
    })),
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/dashboard/products"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to products
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Edit product
        </h1>
      </div>
      <ProductForm businessId={businessId} product={values} />
    </div>
  );
}
