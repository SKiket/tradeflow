import { CartProvider } from "./cart-provider";

export default async function StorefrontSlugLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <CartProvider slug={slug}>{children}</CartProvider>;
}
