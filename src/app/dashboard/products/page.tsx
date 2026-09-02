import Link from "next/link";

import { isVariantLowStock } from "@/lib/products/stock";

import { requireSeller } from "../require-seller";
import { ProductsList, type ProductListRow } from "./products-list";

type VariantStockRow = {
  id: string;
  deleted_at: string | null;
  track_inventory: boolean | null;
  stock_quantity: number | null;
  reserved_quantity: number | null;
  low_stock_threshold: number | null;
};

export default async function ProductsPage() {
  const { supabase, businessId } = await requireSeller();
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, name, price_pence, active, updated_at, product_variants(id, deleted_at, track_inventory, stock_quantity, reserved_quantity, low_stock_threshold)",
    )
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Products</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load products. {error.message}
        </p>
      </div>
    );
  }

  const products: ProductListRow[] = (data ?? []).map((row) => {
    const variants = (
      Array.isArray(row.product_variants) ? row.product_variants : []
    ) as VariantStockRow[];
    const live = variants.filter((variant) => !variant.deleted_at);
    return {
      id: row.id as string,
      name: row.name as string,
      price_pence: row.price_pence as number,
      active: row.active as boolean,
      variant_count: live.length,
      low_stock: live.some((variant) => isVariantLowStock(variant)),
      updated_at: row.updated_at as string,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="tf-page-heading">Products</h1>
          <p className="text-sm text-muted-foreground">
            {products.length === 0
              ? "Your catalogue will appear here."
              : `${products.length} product${products.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/products/import"
            className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
          >
            Import CSV
          </Link>
          <Link
            href="/dashboard/products/new"
            className="inline-flex h-8 items-center rounded-lg bg-tradeflow-cta px-3 text-sm font-medium text-tradeflow-cta-text hover:bg-tradeflow-cta-hover"
          >
            Add product
          </Link>
        </div>
      </div>
      <ProductsList products={products} />
    </div>
  );
}
