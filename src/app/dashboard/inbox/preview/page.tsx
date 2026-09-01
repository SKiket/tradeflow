import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { InboxPreviewForm } from "./preview-form";

export default function InboxPreviewPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/dashboard/inbox"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to inbox
        </Link>
        <h1 className="tf-page-heading mt-3">
          Preview AI replies
        </h1>
        <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Sandbox only. This calls the real assistant against your live catalog
          and settings, but it does not send WhatsApp, create orders, or write
          to the messages table.
        </p>
      </div>
      <InboxPreviewForm />
    </div>
  );
}
