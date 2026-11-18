import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { StorefrontLegalFooter } from "@/components/brand/legal-links";
import { PoweredByTradeFlow } from "@/components/brand/powered-by";
import { formatPence } from "@/lib/orders/display";
import { resolveOgImageUrl, shareMetadata } from "@/lib/seo/open-graph";
import { fetchPublicProduct } from "@/lib/storefront/catalog";
import { productUrl, shopUrl } from "@/lib/storefront/url";

export const dynamic = "force-dynamic";

interface ProductPageProps {
  params: Promise<{ slug: string; productId: string }>;
}

export async function generateMetadata({
  params,
}: ProductPageProps): Promise<Metadata> {
  const { slug, productId } = await params;
  const page = await fetchPublicProduct(slug, productId);
  if (!page) {
    return { title: "Product not found" };
  }
  const { storefront, product } = page;
  const url = productUrl(
    { slug: storefront.slug },
    { id: product.id },
  );
  const description =
    product.description?.trim() ||
    storefront.bio?.trim() ||
    `${product.name} from ${storefront.name}`;
  const image =
    product.photoUrl ||
    product.imageUrls[0] ||
    storefront.bannerUrl ||
    storefront.logoUrl;
  return shareMetadata({
    title: `${product.name} · ${storefront.name}`,
    description,
    url,
    imageUrl: resolveOgImageUrl(image, storefront.logoUrl),
    imageAlt: product.name,
  });
}

export default async function StorefrontProductPage({
  params,
}: ProductPageProps) {
  await connection();
  const { slug, productId } = await params;
  const page = await fetchPublicProduct(slug, productId);
  if (!page) notFound();

  const { storefront, product } = page;
  const shopHref = shopUrl({ slug: storefront.slug });
  const image = product.photoUrl || product.imageUrls[0] || null;

  return (
    <div className="mx-auto min-h-full max-w-lg px-4 pb-10 pt-6">
      <p className="text-sm text-[var(--tf-text-secondary)]">
        <Link href={shopHref} className="underline-offset-4 hover:underline">
          {storefront.name}
        </Link>
      </p>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-2xl font-semibold tracking-[-0.3px]">
        {product.name}
      </h1>
      <p className="mt-1 text-base font-medium">
        {formatPence(product.pricePence)}
      </p>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt={product.name}
          className="mt-4 aspect-square w-full rounded-[16px] object-cover"
        />
      ) : null}
      {product.description?.trim() ? (
        <p className="mt-4 whitespace-pre-wrap text-sm text-[var(--tf-text-secondary)]">
          {product.description.trim()}
        </p>
      ) : null}
      {product.variants.length > 0 ? (
        <ul className="mt-4 space-y-1 text-sm">
          {product.variants.map((variant) => (
            <li key={variant.id}>
              {variant.label?.trim() || "Standard"}
              {variant.stockStatus === "out_of_stock"
                ? " — out of stock"
                : variant.stockStatus === "low_stock"
                  ? " — low stock"
                  : variant.stockStatus === "in_stock"
                    ? " — in stock"
                    : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="mt-10 border-t border-[var(--tf-border)] pt-8">
        <PoweredByTradeFlow />
        <StorefrontLegalFooter />
      </footer>
    </div>
  );
}
