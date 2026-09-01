"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Package, RotateCcw, ShieldCheck } from "lucide-react";

import { StorefrontLegalFooter } from "@/components/brand/legal-links";
import { PoweredByTradeFlow } from "@/components/brand/powered-by";
import { formatPence } from "@/lib/orders/display";
import {
  catalogLine,
  type PublicStorefront,
  type StockStatus,
} from "@/lib/storefront/catalog";
import {
  SHOP_UNAVAILABLE_STOREFRONT_DETAIL,
  SHOP_UNAVAILABLE_STOREFRONT_HEADLINE,
} from "@/lib/stripe/billing-gate";

import { NodesRingMotif } from "./nodes-ring";
import { useCart } from "./cart-provider";

const STOCK_LABEL: Record<StockStatus, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
};

function shopSubheading(storefront: PublicStorefront) {
  const bio = storefront.bio?.trim();
  if (bio) return bio;
  return `Shop ${storefront.name}'s products`;
}

export function StorefrontView({ storefront }: { storefront: PublicStorefront }) {
  const cart = useCart();
  const totalPence = useMemo(() => {
    return cart.lines.reduce((sum, line) => {
      const found = catalogLine(storefront, line.variantId);
      return found ? sum + found.pricePence * line.quantity : sum;
    }, 0);
  }, [cart.lines, storefront]);

  if (!storefront.takingOrders) {
    return (
      <div className="mx-auto min-h-full max-w-lg">
        <StorefrontHeader storefront={storefront} />
        <StorefrontHero storefront={storefront} hideBrowse />
        <main className="px-4 pb-8 pt-6">
          <div className="rounded-[16px] border border-[var(--tf-border)] bg-[var(--tf-bg-surface)] px-4 py-12 text-center">
            <p className="text-base font-semibold">
              {SHOP_UNAVAILABLE_STOREFRONT_HEADLINE}
            </p>
            <p className="mt-2 text-sm text-[var(--tf-text-secondary)]">
              {SHOP_UNAVAILABLE_STOREFRONT_DETAIL}
            </p>
          </div>
        </main>
        <footer className="border-t border-[var(--tf-border)] px-4 pb-10 pt-8">
          <p className="text-center font-[family-name:var(--font-heading)] text-lg font-semibold tracking-[-0.3px]">
            {storefront.name}
          </p>
          <PoweredByTradeFlow />
          <StorefrontLegalFooter />
        </footer>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-full max-w-lg">
      <StorefrontHeader storefront={storefront} />
      <StorefrontHero storefront={storefront} />
      <TrustStrip hasReturnsPolicy={storefront.hasReturnsPolicy} />

      <main id="catalog" className="px-4 pb-8 pt-6">
        <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--tf-text-muted)]">
          Products
        </h2>
        {storefront.products.length === 0 ? (
          <div className="rounded-[16px] border border-dashed border-[var(--tf-border)] bg-[var(--tf-bg-surface)] px-4 py-12 text-center">
            <p className="text-base font-semibold">No products available</p>
            <p className="mt-1 text-sm text-[var(--tf-text-secondary)]">
              {storefront.name} hasn&apos;t listed any items yet. Check back
              soon.
            </p>
          </div>
        ) : (
          <ul className="space-y-5">
            {storefront.products.map((product) => (
              <li key={`${product.name}-${product.variants[0]?.id ?? product.pricePence}`}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="border-t border-[var(--tf-border)] px-4 pb-28 pt-8">
        <p className="text-center font-[family-name:var(--font-heading)] text-lg font-semibold tracking-[-0.3px]">
          {storefront.name}
        </p>
        <PoweredByTradeFlow />
        <StorefrontLegalFooter />
      </footer>

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

function StorefrontHeader({ storefront }: { storefront: PublicStorefront }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = Boolean(storefront.logoUrl) && !logoFailed;

  return (
    <header className="flex items-center gap-3 border-b border-[var(--tf-border)] bg-[var(--tf-bg-surface)] px-4 py-3">
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={storefront.logoUrl ?? ""}
          alt=""
          className="size-10 shrink-0 rounded-[12px] object-cover ring-1 ring-[var(--tf-border)]"
          onError={() => setLogoFailed(true)}
        />
      ) : (
        <div
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-[12px] text-sm font-semibold"
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
      <p className="min-w-0 truncate font-[family-name:var(--font-heading)] text-base font-semibold tracking-[-0.2px]">
        {storefront.name}
      </p>
    </header>
  );
}

function StorefrontHero({
  storefront,
  hideBrowse = false,
}: {
  storefront: PublicStorefront;
  hideBrowse?: boolean;
}) {
  const [bannerFailed, setBannerFailed] = useState(false);
  const showBanner = Boolean(storefront.bannerUrl) && !bannerFailed;
  const subheading = shopSubheading(storefront);

  return (
    <section className="relative overflow-hidden">
      {showBanner ? (
        <>
          <div className="absolute inset-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={storefront.bannerUrl ?? ""}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setBannerFailed(true)}
            />
          </div>
          <div className="tf-hero-scrim absolute inset-0" />
        </>
      ) : (
        <div className="tf-storefront-hero absolute inset-0">
          <div className="pointer-events-none absolute -right-8 top-2 h-48 w-48">
            <NodesRingMotif className="h-full w-full" />
          </div>
        </div>
      )}

      <div
        className={`relative flex min-h-[20rem] flex-col justify-end px-5 pb-8 pt-14 ${
          showBanner ? "text-[var(--tf-text-on-navy)]" : ""
        }`}
      >
        <h1 className="tf-hero-name">{storefront.name}</h1>
        <p
          className={`mt-3 max-w-[22rem] text-[15px] leading-7 ${
            showBanner
              ? "text-white/90"
              : "text-[var(--tf-text-secondary)]"
          }`}
        >
          {subheading}
        </p>
        {!hideBrowse ? (
          <a
            href="#catalog"
            className="tf-storefront-cta mt-6 inline-flex min-h-11 w-fit items-center justify-center rounded-[12px] px-4 text-sm font-semibold"
          >
            Browse products
          </a>
        ) : null}
        {!storefront.acceptingOrders ? (
          <p
            className={`mt-4 rounded-[12px] border px-3 py-2.5 text-sm ${
              showBanner
                ? "border-white/25 bg-black/25 text-white/90"
                : "border-[var(--tf-border)] bg-[var(--tf-bg-surface)] text-[var(--tf-text-secondary)]"
            }`}
          >
            WhatsApp ordering isn&apos;t available yet. You can still add items
            to your cart and check out on the web.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TrustStrip({ hasReturnsPolicy }: { hasReturnsPolicy: boolean }) {
  return (
    <section
      data-tf-trust-strip=""
      className="tf-trust-strip flex flex-wrap gap-x-5 gap-y-2.5 border-b px-4 py-3.5"
    >
      <TrustItem icon={<ShieldCheck className="size-4 shrink-0" strokeWidth={1.75} />} label="Secure checkout" />
      <TrustItem icon={<Package className="size-4 shrink-0" strokeWidth={1.75} />} label="Tracked delivery" />
      {hasReturnsPolicy ? (
        <TrustItem
          icon={<RotateCcw className="size-4 shrink-0" strokeWidth={1.75} />}
          label="Easy returns"
        />
      ) : null}
    </section>
  );
}

function TrustItem({
  icon,
  label,
}: {
  icon: ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--tf-text-secondary)]">
      <span className="text-[var(--tenant-accent)]">{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function ProductPhoto({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  const showPhoto = Boolean(src) && !failed;

  return (
    <div className="tf-product-slot relative aspect-[4/3] overflow-hidden">
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src ?? ""}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <NodesRingMotif />
        </div>
      )}
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
  const stockStatus = selected?.stockStatus ?? null;

  return (
    <article className="scroll-mb-28 overflow-hidden rounded-[16px] border border-[var(--tf-border)] bg-[var(--tf-bg-surface)] shadow-sm">
      <ProductPhoto src={product.photoUrl} />
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <h3 className="tf-product-name">{product.name}</h3>
            {stockStatus ? (
              <span className="tf-stock-pill" data-status={stockStatus}>
                {STOCK_LABEL[stockStatus]}
              </span>
            ) : null}
          </div>
          <p className="shrink-0 pt-0.5 text-2xl font-semibold tabular-nums leading-none">
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
