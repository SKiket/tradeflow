import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { fetchPublicStorefront } from "@/lib/storefront/catalog";
import {
  SHOP_UNAVAILABLE_STOREFRONT_DETAIL,
  SHOP_UNAVAILABLE_STOREFRONT_HEADLINE,
} from "@/lib/stripe/billing-gate";

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

  if (!storefront.takingOrders) {
    return (
      <div data-tf-surface="checkout" className="mx-auto min-h-full max-w-lg px-4 py-8">
        <Link
          href={`/s/${storefront.slug}`}
          className="text-sm text-[var(--tf-text-secondary)] underline-offset-4 hover:underline"
        >
          ← Back to shop
        </Link>
        <h1 className="tf-page-heading mt-4">{storefront.name}</h1>
        <div className="mt-6 rounded-[16px] border border-[var(--tf-border)] bg-[var(--tf-bg-surface)] px-4 py-12 text-center">
          <p className="text-base font-semibold">
            {SHOP_UNAVAILABLE_STOREFRONT_HEADLINE}
          </p>
          <p className="mt-2 text-sm text-[var(--tf-text-secondary)]">
            {SHOP_UNAVAILABLE_STOREFRONT_DETAIL}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-tf-surface="checkout" className="mx-auto min-h-full max-w-lg px-4 py-8">
      <Link
        href={`/s/${storefront.slug}`}
        className="text-sm text-[var(--tf-text-secondary)] underline-offset-4 hover:underline"
      >
        ← Back to catalog
      </Link>
      <h1 className="tf-page-heading mt-4">Checkout</h1>
      <p className="mt-1 text-sm text-[var(--tf-text-secondary)]">{storefront.name}</p>
      <div className="mt-6">
        <CheckoutForm storefront={storefront} />
      </div>
    </div>
  );
}
