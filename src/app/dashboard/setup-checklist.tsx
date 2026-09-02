import Link from "next/link";
import { Check, Circle, Clock } from "lucide-react";

import {
  setupActionableCompleteCount,
  setupChecklistItems,
  setupChecklistShouldShow,
  type SetupProgress,
} from "@/lib/dashboard/setup-progress";
import { cn } from "@/lib/utils";

export function SetupChecklist({ progress }: { progress: SetupProgress }) {
  if (!setupChecklistShouldShow(progress)) return null;

  const items = setupChecklistItems(progress);
  const { done, total } = setupActionableCompleteCount(progress);

  return (
    <section
      data-setup-checklist=""
      className="mb-6 rounded-xl border bg-muted/20 p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Finish setting up your shop
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {done} of {total} done. WhatsApp connection will open after platform
            rollout — it is not required to finish this list.
          </p>
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {items.map((item) => {
          const row = (
            <span className="flex min-w-0 items-start gap-3">
              <span
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                  item.state === "complete" && "bg-emerald-100 text-emerald-950",
                  item.state === "incomplete" && "bg-muted text-muted-foreground",
                  item.state === "pending" && "bg-amber-100 text-amber-950",
                )}
              >
                {item.state === "complete" ? (
                  <Check className="size-3.5" />
                ) : item.state === "pending" ? (
                  <Clock className="size-3.5" />
                ) : (
                  <Circle className="size-3.5" />
                )}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-sm font-medium",
                    item.state === "complete" && "text-muted-foreground",
                  )}
                >
                  {item.label}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {item.detail}
                </span>
              </span>
            </span>
          );

          return (
            <li
              key={item.id}
              data-setup-item={item.id}
              data-setup-state={item.state}
            >
              {item.state === "incomplete" && item.href ? (
                <Link
                  href={item.href}
                  className="block rounded-lg px-2 py-2 hover:bg-muted/60"
                >
                  {row}
                </Link>
              ) : (
                <div className="px-2 py-2">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
