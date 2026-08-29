"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Package } from "lucide-react";

import { formatPence } from "@/lib/orders/display";

import { ActiveToggle } from "./active-toggle";

export type ProductListRow = {
  id: string;
  name: string;
  price_pence: number;
  active: boolean;
  variant_count: number;
  low_stock: boolean;
  updated_at: string;
};

function LowStockBadge() {
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-950">
      Low stock
    </span>
  );
}

export function ProductsList({ products }: { products: ProductListRow[] }) {
  const router = useRouter();

  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-16 text-center">
        <Package className="size-10 text-muted-foreground" />
        <h2 className="mt-4 text-lg font-semibold">No products yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Add what you sell so customers can order over WhatsApp. Nothing
          shows in the catalogue until you create your first product.
        </p>
        <Link
          href="/dashboard/products/new"
          className="mt-4 inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          Add product
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2 md:hidden">
        {products.map((product) => (
          <div
            key={product.id}
            role="link"
            tabIndex={0}
            onClick={() => router.push(`/dashboard/products/${product.id}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                router.push(`/dashboard/products/${product.id}`);
              }
            }}
            className={`flex w-full cursor-pointer flex-col gap-2 rounded-xl border p-4 text-left shadow-xs transition-colors hover:bg-muted/40 ${
              product.low_stock ? "border-amber-200 bg-amber-50/70" : "bg-card"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-medium">{product.name}</span>
                {product.low_stock ? <LowStockBadge /> : null}
              </span>
              <ActiveToggle productId={product.id} active={product.active} />
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{formatPence(product.price_pence)}</span>
              <span>
                {product.variant_count} variant
                {product.variant_count === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-xl border md:block">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3 text-right">Price</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Variants</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr
                key={product.id}
                tabIndex={0}
                className={`cursor-pointer border-b last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none ${
                  product.low_stock ? "bg-amber-50/70" : ""
                }`}
                onClick={() => router.push(`/dashboard/products/${product.id}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    router.push(`/dashboard/products/${product.id}`);
                  }
                }}
              >
                <td className="px-4 py-3 font-medium">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/products/${product.id}`}
                      className="hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {product.name}
                    </Link>
                    {product.low_stock ? <LowStockBadge /> : null}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatPence(product.price_pence)}
                </td>
                <td
                  className="px-4 py-3"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ActiveToggle productId={product.id} active={product.active} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {product.variant_count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
