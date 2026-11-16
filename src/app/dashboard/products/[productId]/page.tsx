import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { ProductForm, type ProductFormValues } from "../product-form";
import { requireSeller } from "../../require-seller";

interface EditProductPageProps {
  params: Promise<{ productId: string }>;
}

export default async function EditProductPage({ params }: EditProductPageProps) {
  const { productId } = await params;
  const { supabase, businessId } = await requireSeller();

  const { data: product } = await supabase
    .from("products")
    .select(
      "id, name, description, price_pence, photo_url, active, usage_instructions, ingredients, storage_and_care, size_and_fit, allergens_text, allergens_status, product_faqs, product_images(id, image_url, sort_order), product_variants(id, label, stock_quantity, low_stock_threshold, track_inventory, weight_grams)",
    )
    .eq("id", productId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (!product) notFound();

  const variants = Array.isArray(product.product_variants)
    ? product.product_variants
    : product.product_variants
      ? [product.product_variants]
      : [];

  const images = Array.isArray(product.product_images)
    ? product.product_images
    : product.product_images
      ? [product.product_images]
      : [];

  const faqsRaw = Array.isArray(product.product_faqs)
    ? product.product_faqs
    : [];
  const values: ProductFormValues = {
    id: product.id as string,
    name: product.name as string,
    description: (product.description as string | null) ?? null,
    price_pence: product.price_pence as number,
    photo_url: (product.photo_url as string | null) ?? null,
    images: images.map((image) => ({
      id: image.id as string,
      image_url: image.image_url as string,
      sort_order: image.sort_order as number,
    })),
    active: product.active as boolean,
    usage_instructions: (product.usage_instructions as string | null) ?? null,
    ingredients: (product.ingredients as string | null) ?? null,
    storage_and_care: (product.storage_and_care as string | null) ?? null,
    size_and_fit: (product.size_and_fit as string | null) ?? null,
    allergens_text: (product.allergens_text as string | null) ?? null,
    allergens_status:
      (product.allergens_status as ProductFormValues["allergens_status"]) ??
      "not_provided",
    product_faqs: faqsRaw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const rec = item as Record<string, unknown>;
        const question =
          typeof rec.question === "string" ? rec.question : "";
        const answer = typeof rec.answer === "string" ? rec.answer : "";
        if (!question || !answer) return null;
        return { question, answer };
      })
      .filter((item): item is { question: string; answer: string } =>
        Boolean(item),
      ),
    variants: variants.map((variant) => ({
      id: variant.id as string,
      label: (variant.label as string | null) ?? null,
      stock_quantity: variant.stock_quantity as number,
      low_stock_threshold: variant.low_stock_threshold as number,
      track_inventory: variant.track_inventory as boolean,
      weight_grams: (variant.weight_grams as number | null) ?? 200,
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
        <h1 className="tf-page-heading mt-3">
          Edit product
        </h1>
      </div>
      <ProductForm businessId={businessId} product={values} />
    </div>
  );
}
