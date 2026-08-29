import Link from "next/link";

export default function InboxThreadNotFound() {
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Thread not found</h1>
      <p className="text-sm text-muted-foreground">
        This conversation doesn&apos;t exist or belongs to another shop.
      </p>
      <Link
        href="/dashboard/inbox"
        className="inline-flex text-sm font-medium hover:underline"
      >
        Back to inbox
      </Link>
    </div>
  );
}
