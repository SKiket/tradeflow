"use client";

import { useRouter } from "next/navigation";
import { Inbox } from "lucide-react";

import { formatDateTime } from "@/lib/orders/display";
import {
  threadStatusClass,
  threadStatusLabel,
  type InboxThreadStatus,
} from "@/lib/inbox/status";
import { cn } from "@/lib/utils";

export type InboxListRow = {
  threadId: string;
  customerName: string | null;
  customerPhone: string | null;
  lastMessagePreview: string;
  lastMessageAt: string;
  status: InboxThreadStatus;
  aiPaused: boolean;
};

function ThreadStatusBadge({ status }: { status: InboxThreadStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        threadStatusClass(status),
      )}
    >
      {threadStatusLabel(status)}
    </span>
  );
}

export function InboxList({ threads }: { threads: InboxListRow[] }) {
  const router = useRouter();

  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-16 text-center">
        <Inbox className="size-10 text-muted-foreground" />
        <h2 className="mt-4 text-lg font-semibold">No conversations yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          When buyers message your shop WhatsApp, the full thread will appear
          here — including questions and order attempts that never became an
          order.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-2 md:hidden">
        {threads.map((thread) => (
          <button
            key={thread.threadId}
            type="button"
            onClick={() => router.push(`/dashboard/inbox/${thread.threadId}`)}
            className="flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:bg-muted/40"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold">
                {thread.customerName || thread.customerPhone || "Unknown buyer"}
              </span>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                {thread.aiPaused ? (
                  <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-950 whitespace-nowrap">
                    You&apos;re handling
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 whitespace-nowrap">
                    AI covering
                  </span>
                )}
                <ThreadStatusBadge status={thread.status} />
              </div>
            </div>
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {thread.lastMessagePreview}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(thread.lastMessageAt)}
            </p>
          </button>
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-xl border md:block">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Last message</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">AI</th>
              <th className="px-4 py-3">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {threads.map((thread) => (
              <tr
                key={thread.threadId}
                tabIndex={0}
                className="cursor-pointer border-b last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                onClick={() =>
                  router.push(`/dashboard/inbox/${thread.threadId}`)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    router.push(`/dashboard/inbox/${thread.threadId}`);
                  }
                }}
              >
                <td className="px-4 py-3">
                  <p className="font-medium">
                    {thread.customerName || thread.customerPhone || "Unknown buyer"}
                  </p>
                  {thread.customerName && thread.customerPhone ? (
                    <p className="text-xs text-muted-foreground">
                      {thread.customerPhone}
                    </p>
                  ) : null}
                </td>
                <td className="max-w-md px-4 py-3 text-muted-foreground">
                  <p className="line-clamp-2">{thread.lastMessagePreview}</p>
                </td>
                <td className="px-4 py-3">
                  <ThreadStatusBadge status={thread.status} />
                </td>
                <td className="px-4 py-3">
                  {thread.aiPaused ? (
                    <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-950 whitespace-nowrap">
                      You&apos;re handling
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">AI covering</span>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                  {formatDateTime(thread.lastMessageAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
