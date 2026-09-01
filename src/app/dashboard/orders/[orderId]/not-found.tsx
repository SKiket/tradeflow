import Link from "next/link";

export default function OrderNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="tf-page-heading">Order not found</h1>
      <p className="text-sm text-muted-foreground">
        This order doesn&apos;t exist, or it belongs to another business.
      </p>
      <Link
        href="/dashboard/orders"
        className="inline-block text-sm font-medium hover:underline"
      >
        Back to orders
      </Link>
    </div>
  );
}
