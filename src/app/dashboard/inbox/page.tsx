import Link from "next/link";

import { listInboxThreads } from "@/lib/inbox/list-threads";

import { requireSeller } from "../require-seller";
import { InboxList } from "./inbox-list";

export default async function InboxPage() {
  const { supabase } = await requireSeller();

  let threads;
  try {
    threads = await listInboxThreads(supabase);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">Inbox</h1>
        <p className="text-sm text-destructive">
          Couldn&apos;t load conversations. {message}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="tf-page-heading">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            {threads.length === 0
              ? "Your WhatsApp conversations will appear here."
              : `${threads.length} conversation${threads.length === 1 ? "" : "s"}, newest first.`}
          </p>
        </div>
        <Link
          href="/dashboard/inbox/preview"
          className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
        >
          Preview AI replies
        </Link>
      </div>
      <InboxList threads={threads} />
    </div>
  );
}
