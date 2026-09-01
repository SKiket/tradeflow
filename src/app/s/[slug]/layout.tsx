import { fetchPublicStorefront } from "@/lib/storefront/catalog";
import { tenantAccentStyle } from "@/lib/brand/accent";

import { CartProvider } from "./cart-provider";

export default async function StorefrontSlugLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const storefront = await fetchPublicStorefront(slug);

  return (
    <div data-tf-surface="storefront" style={tenantAccentStyle(storefront?.accentColor)}>
      <CartProvider slug={slug}>{children}</CartProvider>
    </div>
  );
}
