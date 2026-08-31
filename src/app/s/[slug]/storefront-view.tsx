"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { formatPence } from "@/lib/orders/display";
import { catalogLine, type PublicStorefront } from "@/lib/storefront/catalog";

import { useCart } from "./cart-provider";

export function StorefrontView({ storefront }: { storefront: PublicStorefront }) {
  const cart = useCart();
  const totalPence = useMemo(() => {
    return cart.lines.reduce((sum, line) => {
      const found = catalogLine(storefront, line.variantId);
      return found ? sum + found.pricePence * line.quantity : sum;
    }, 0);
  }, [cart.lines, storefront]);

  return (
    <div className="mx-auto min-h-full max-w-lg">
      {storefront.bannerUrl ? (
        <div className="aspect-[3/1] w-full overflow-hidden bg-zinc-200">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={storefront.bannerUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
      ) : null}

      <header className="px-4 pb-4 pt-6">
        <div className="flex items-start gap-3">
          {storefront.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={storefront.logoUrl}
              alt=""
              className="size-14 shrink-0 rounded-2xl object-cover ring-1 ring-zinc-200"
            />
          ) : (
            <div
              aria-hidden
              className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-zinc-900 text-lg font-semibold text-white"
            >
              {storefront.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 pt-0.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              {storefront.name}
            </h1>
            {storefront.bio ? (
              <p className="mt-1 text-sm leading-6 text-zinc-600">
                {storefront.bio}
              </p>
            ) : null}
          </div>
        </div>

        {!storefront.acceptingOrders ? (
          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
            WhatsApp ordering isn&apos;t available yet. You can still add items
            to your cart and check out on the web.
          </p>
        ) : null}
      </header>

      <main className="px-4 pb-36">
        {storefront.products.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white px-4 py-12 text-center">
            <h2 className="text-base font-semibold">No products available</h2>
            <p className="mt-1 text-sm text-zinc-600">
              {storefront.name} hasn&apos;t listed any items yet. Check back
              soon.
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {storefront.products.map((product) => (
              <li key={`${product.name}-${product.variants[0]?.id ?? product.pricePence}`}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        )}
      </main>

      {cart.hydrated && cart.itemCount > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {cart.itemCount} item{cart.itemCount === 1 ? "" : "s"}
              </p>
              <p className="text-sm text-zinc-600">{formatPence(totalPence)}</p>
            </div>
            <Link
              href={`/s/${storefront.slug}/checkout`}
              className="flex min-h-11 items-center justify-center rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
            >
              Checkout
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProductCard({
  product,
}: {
  product: PublicStorefront["products"][number];
}) {
  const cart = useCart();
  const [selectedId, setSelectedId] = useState(product.variants[0]?.id ?? "");
  const selected =
    product.variants.find((variant) => variant.id === selectedId) ??
    product.variants[0];
  const hasVariants = product.variants.length > 1;

  return (
    <article className="scroll-mb-28 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      {product.photoUrl ? (
        <div className="aspect-[4/3] bg-zinc-100">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={product.photoUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
      ) : null}
      <div className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">{product.name}</h2>
          <p className="shrink-0 text-base font-medium">
            {formatPence(product.pricePence)}
          </p>
        </div>
        {product.description ? (
          <p className="text-sm leading-6 text-zinc-600">{product.description}</p>
        ) : null}

        {hasVariants ? (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-zinc-700">Option</span>
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              className="h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-sm"
            >
              {product.variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.label ?? "Standard"}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {selected ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => cart.add(selected.id)}
              className="flex min-h-11 items-center justify-center rounded-xl bg-zinc-900 px-3 text-sm font-semibold text-white hover:bg-zinc-800"
            >
              Add to cart
              {hasVariants && selected.label ? ` · ${selected.label}` : ""}
            </button>
            {selected.orderUrl ? (
              <a
                href={selected.orderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-11 items-center justify-center rounded-xl bg-[#25D366] px-3 text-sm font-semibold text-white hover:bg-[#1ebe5d]"
              >
                {hasVariants && selected.label
                  ? `Order ${selected.label} via WhatsApp`
                  : "Order via WhatsApp"}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
