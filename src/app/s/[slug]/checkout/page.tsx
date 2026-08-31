import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { fetchPublicStorefront } from "@/lib/storefront/catalog";

import { CheckoutForm } from "./checkout-form";

export const dynamic = "force-dynamic";

interface CheckoutPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: CheckoutPageProps): Promise<Metadata> {
  const { slug } = await params;
  const storefront = await fetchPublicStorefront(slug);
  if (!storefront) {
    return { title: "Checkout" };
  }
  return { title: `Checkout · ${storefront.name}` };
}

export default async function StorefrontCheckoutPage({
  params,
}: CheckoutPageProps) {
  await connection();
  const { slug } = await params;
  const storefront = await fetchPublicStorefront(slug);
  if (!storefront) notFound();

  return (
    <div className="mx-auto min-h-full max-w-lg px-4 py-8">
      <Link
        href={`/s/${storefront.slug}`}
        className="text-sm text-zinc-600 underline-offset-4 hover:underline"
      >
        ← Back to catalog
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Checkout</h1>
      <p className="mt-1 text-sm text-zinc-600">{storefront.name}</p>
      <div className="mt-6">
        <CheckoutForm storefront={storefront} />
      </div>
    </div>
  );
}
