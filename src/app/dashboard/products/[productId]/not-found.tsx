import Link from "next/link";

export default function ProductNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="tf-page-heading">Product not found</h1>
      <p className="text-sm text-muted-foreground">
        This product doesn&apos;t exist, or it belongs to another business.
      </p>
      <Link
        href="/dashboard/products"
        className="inline-block text-sm font-medium hover:underline"
      >
        Back to products
      </Link>
    </div>
  );
}
