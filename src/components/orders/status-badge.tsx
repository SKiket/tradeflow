import { statusBadgeClass, statusLabel } from "@/lib/orders/display";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        statusBadgeClass(status),
      )}
    >
      {statusLabel(status)}
    </span>
  );
}
