import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { formatPence } from "@/lib/orders/display";
import {
  fetchPublicStorefront,
  type PublicStorefront,
  type PublicStorefrontProduct,
} from "@/lib/storefront/catalog";

export const dynamic = "force-dynamic";

interface StorefrontPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: StorefrontPageProps): Promise<Metadata> {
  const { slug } = await params;
  const storefront = await fetchPublicStorefront(slug);
  if (!storefront) {
    return { title: "Store not found" };
  }
  return {
    title: storefront.name,
    description: storefront.bio ?? `${storefront.name} catalog`,
  };
}

export default async function StorefrontPage({ params }: StorefrontPageProps) {
  await connection();
  const { slug } = await params;
  const storefront = await fetchPublicStorefront(slug);
  if (!storefront) notFound();

  return <StorefrontView storefront={storefront} />;
}

function StorefrontView({ storefront }: { storefront: PublicStorefront }) {
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
            This store isn&apos;t accepting orders yet. You can browse the
            catalog, but WhatsApp ordering is not available.
          </p>
        ) : null}
      </header>

      <main className="px-4 pb-16">
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
              <li key={`${product.name}-${product.pricePence}`}>
                <ProductCard
                  product={product}
                  acceptingOrders={storefront.acceptingOrders}
                />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function ProductCard({
  product,
  acceptingOrders,
}: {
  product: PublicStorefrontProduct;
  acceptingOrders: boolean;
}) {
  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
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
          <h2 className="text-lg font-semibold tracking-tight">
            {product.name}
          </h2>
          <p className="shrink-0 text-base font-medium">
            {formatPence(product.pricePence)}
          </p>
        </div>
        {product.description ? (
          <p className="text-sm leading-6 text-zinc-600">{product.description}</p>
        ) : null}

        {acceptingOrders ? (
          <div className="space-y-2">
            {product.variants.map((variant, index) => (
              <a
                key={`${variant.label ?? "default"}-${index}`}
                href={variant.orderUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-11 w-full items-center justify-center rounded-xl bg-[#25D366] px-3 text-sm font-semibold text-white hover:bg-[#1ebe5d]"
              >
                {product.variants.length > 1 && variant.label
                  ? `Order ${variant.label} via WhatsApp`
                  : "Order via WhatsApp"}
              </a>
            ))}
          </div>
        ) : (
          <p className="rounded-xl bg-zinc-100 px-3 py-2 text-center text-sm text-zinc-600">
            Ordering isn&apos;t available yet
          </p>
        )}
      </div>
    </article>
  );
}
