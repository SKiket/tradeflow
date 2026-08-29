import Link from "next/link";

import { requireSeller } from "../require-seller";
import { ProductsList, type ProductListRow } from "./products-list";

export default async function ProductsPage() {
  const { supabase } = await requireSeller();
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, name, price_pence, active, updated_at, product_variants(id)",
    )
    .order("updated_at", { ascending: false });

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load products. {error.message}
        </p>
      </div>
    );
  }

  const products: ProductListRow[] = (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    price_pence: row.price_pence as number,
    active: row.active as boolean,
    variant_count: Array.isArray(row.product_variants)
      ? row.product_variants.length
      : 0,
    updated_at: row.updated_at as string,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground">
            {products.length === 0
              ? "Your catalogue will appear here."
              : `${products.length} product${products.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        <Link
          href="/dashboard/products/new"
          className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          Add product
        </Link>
      </div>
      <ProductsList products={products} />
    </div>
  );
}
