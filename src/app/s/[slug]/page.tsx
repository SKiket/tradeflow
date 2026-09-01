import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { fetchPublicStorefront } from "@/lib/storefront/catalog";
import { storefrontUrl } from "@/lib/storefront/url";
import { resolveOgImageUrl, shareMetadata } from "@/lib/seo/open-graph";

import { StorefrontView } from "./storefront-view";

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
  const url = storefrontUrl(storefront.slug);
  const description =
    storefront.bio?.trim() || `Shop ${storefront.name} on TradeFlow`;
  return shareMetadata({
    title: storefront.name,
    description,
    url,
    imageUrl: resolveOgImageUrl(storefront.bannerUrl, storefront.logoUrl),
    imageAlt: storefront.name,
  });
}

export default async function StorefrontPage({ params }: StorefrontPageProps) {
  await connection();
  const { slug } = await params;
  const storefront = await fetchPublicStorefront(slug);
  if (!storefront) notFound();

  return <StorefrontView storefront={storefront} />;
}
