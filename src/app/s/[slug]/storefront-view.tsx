"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { PoweredByTradeFlow } from "@/components/brand/powered-by";
import { formatPence } from "@/lib/orders/display";
import {
  catalogLine,
  type PublicStorefront,
  type StockStatus,
} from "@/lib/storefront/catalog";

import { NodesRingMotif } from "./nodes-ring";
import { useCart } from "./cart-provider";

const STOCK_LABEL: Record<StockStatus, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
};

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
      <StorefrontHero storefront={storefront} />

      <main className="px-4 pb-36 pt-5">
        {storefront.products.length === 0 ? (
          <div className="rounded-[16px] border border-dashed border-[var(--tf-border)] bg-[var(--tf-bg-surface)] px-4 py-12 text-center">
            <h2 className="text-base font-semibold">No products available</h2>
            <p className="mt-1 text-sm text-[var(--tf-text-secondary)]">
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
        <PoweredByTradeFlow />
      </main>

      {cart.hydrated && cart.itemCount > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-[var(--tf-border)] tf-cart-bar px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {cart.itemCount} item{cart.itemCount === 1 ? "" : "s"}
              </p>
              <p className="text-base font-semibold tabular-nums">
                {formatPence(totalPence)}
              </p>
            </div>
            <Link
              href={`/s/${storefront.slug}/checkout`}
              className="tf-storefront-cta flex min-h-11 items-center justify-center rounded-[12px] px-4 text-sm font-semibold"
            >
              Checkout
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StorefrontHero({ storefront }: { storefront: PublicStorefront }) {
  const [bannerFailed, setBannerFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const showBanner = Boolean(storefront.bannerUrl) && !bannerFailed;
  const showLogo = Boolean(storefront.logoUrl) && !logoFailed;

  return (
    <header className="tf-storefront-hero overflow-hidden">
      {showBanner ? (
        <div className="aspect-[3/1] w-full overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={storefront.bannerUrl ?? ""}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setBannerFailed(true)}
          />
        </div>
      ) : null}

      <div className="px-5 pb-6 pt-7">
        <div className="flex items-start gap-3">
          {showLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={storefront.logoUrl ?? ""}
              alt=""
              className="size-14 shrink-0 rounded-[16px] object-cover ring-1 ring-[var(--tf-border)]"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <div
              aria-hidden
              className="flex size-14 shrink-0 items-center justify-center rounded-[16px] text-lg font-semibold"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--tenant-accent) 28%, white)",
                color: "var(--tenant-accent-text)",
                fontFamily: "var(--font-heading)",
              }}
            >
              {storefront.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 pt-0.5">
            <h1 className="tf-shop-name">{storefront.name}</h1>
            {storefront.bio ? (
              <p className="mt-1 text-sm leading-6 text-[var(--tf-text-secondary)]">
                {storefront.bio}
              </p>
            ) : null}
          </div>
        </div>

        {!storefront.acceptingOrders ? (
          <p className="mt-4 rounded-[12px] border border-[var(--tf-border)] bg-[var(--tf-bg-surface)] px-3 py-2.5 text-sm text-[var(--tf-text-secondary)]">
            WhatsApp ordering isn&apos;t available yet. You can still add items
            to your cart and check out on the web.
          </p>
        ) : null}
      </div>
    </header>
  );
}

function ProductCard({
  product,
}: {
  product: PublicStorefront["products"][number];
}) {
  const cart = useCart();
  const [selectedId, setSelectedId] = useState(product.variants[0]?.id ?? "");
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const selected =
    product.variants.find((variant) => variant.id === selectedId) ??
    product.variants[0];
  const hasVariants = product.variants.length > 1;
  const showPhoto = Boolean(product.photoUrl) && photoLoaded;
  const stockStatus = selected?.stockStatus ?? null;

  return (
    <article className="scroll-mb-28 overflow-hidden rounded-[16px] border border-[var(--tf-border)] bg-[var(--tf-bg-surface)] shadow-sm">
      <div className="tf-product-slot relative aspect-[4/3] overflow-hidden">
        {product.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.photoUrl}
            alt=""
            className={
              showPhoto
                ? "h-full w-full object-cover"
                : "pointer-events-none absolute size-0 opacity-0"
            }
            onLoad={() => setPhotoLoaded(true)}
            onError={() => setPhotoLoaded(false)}
          />
        ) : null}
        {showPhoto ? null : (
          <div className="flex h-full w-full items-center justify-center">
            <NodesRingMotif />
          </div>
        )}
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <h2 className="tf-product-name">{product.name}</h2>
            {stockStatus ? (
              <span className="tf-stock-pill" data-status={stockStatus}>
                {STOCK_LABEL[stockStatus]}
              </span>
            ) : null}
          </div>
          <p className="shrink-0 pt-0.5 text-lg font-semibold tabular-nums">
            {formatPence(product.pricePence)}
          </p>
        </div>
        {product.description ? (
          <p className="text-sm leading-6 text-[var(--tf-text-secondary)]">
            {product.description}
          </p>
        ) : null}

        {hasVariants ? (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-[var(--tf-text-secondary)]">
              Option
            </span>
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              className="h-11 w-full rounded-[12px] border border-[var(--tf-border)] bg-[var(--tf-bg-surface)] px-3 text-sm"
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
              className="tf-storefront-cta flex min-h-11 items-center justify-center rounded-[12px] px-3 text-sm font-semibold"
            >
              Add to cart
              {hasVariants && selected.label ? ` · ${selected.label}` : ""}
            </button>
            {selected.orderUrl ? (
              <a
                href={selected.orderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="tf-storefront-cta flex min-h-11 items-center justify-center rounded-[12px] px-3 text-sm font-semibold"
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
