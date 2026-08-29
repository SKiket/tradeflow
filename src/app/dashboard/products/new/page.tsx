import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { ProductForm } from "../product-form";
import { requireSeller } from "../../require-seller";

export default async function NewProductPage() {
  const { supabase, businessId } = await requireSeller();
  const { data: business } = await supabase
    .from("businesses")
    .select("default_low_stock_threshold")
    .eq("id", businessId)
    .maybeSingle();

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
          Add product
        </h1>
      </div>
      <ProductForm
        businessId={businessId}
        defaultLowStockThreshold={
          (business?.default_low_stock_threshold as number | null) ?? 5
        }
      />
    </div>
  );
}
