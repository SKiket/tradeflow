import Link from "next/link";

export default function CustomerNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="tf-page-heading">Customer not found</h1>
      <p className="text-sm text-muted-foreground">
        This customer doesn&apos;t exist, or they belong to another business.
      </p>
      <Link
        href="/dashboard/customers"
        className="inline-block text-sm font-medium hover:underline"
      >
        Back to customers
      </Link>
    </div>
  );
}
