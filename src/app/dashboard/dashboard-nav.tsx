"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, ClipboardList, Inbox, Package, Settings } from "lucide-react";

import { cn } from "@/lib/utils";

const NAV = [
  {
    href: "/dashboard/inbox",
    label: "Inbox",
    icon: Inbox,
    live: true,
  },
  {
    href: "/dashboard/orders",
    label: "Orders",
    icon: ClipboardList,
    live: true,
  },
  {
    href: "/dashboard/products",
    label: "Products",
    icon: Package,
    live: true,
  },
  {
    href: "/dashboard/analytics",
    label: "Analytics",
    icon: BarChart3,
    live: true,
  },
  {
    href: "/dashboard/settings",
    label: "Settings",
    icon: Settings,
    live: true,
  },
] as const;

export function DashboardNav({ orientation }: { orientation: "side" | "top" }) {
  const pathname = usePathname();
  const side = orientation === "side";

  return (
    <nav
      className={cn(
        side ? "flex flex-col gap-1" : "flex items-center gap-1 overflow-x-auto",
      )}
      aria-label="Dashboard"
    >
      {NAV.map((item) => {
        const Icon = item.icon;
        const active = item.live && pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2 rounded-lg text-sm font-medium transition-colors",
              side ? "px-3 py-2" : "px-3 py-1.5",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/20",
              !item.live && "text-muted-foreground",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
            {!item.live && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Soon
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
