import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { fetchPublicStorefront } from "@/lib/storefront/catalog";

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
