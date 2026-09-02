"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

export type SwitcherBusiness = {
  id: string;
  name: string;
};

export function BusinessSwitcher({
  businesses,
  activeId,
  variant,
}: {
  businesses: SwitcherBusiness[];
  activeId: string;
  variant: "sidebar" | "header";
}) {
  const router = useRouter();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const active =
    businesses.find((row) => row.id === activeId) ?? businesses[0] ?? null;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function select(businessId: string) {
    if (businessId === activeId || pending) {
      setOpen(false);
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/dashboard/active-business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      });
      if (!response.ok) {
        setPending(false);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const sidebar = variant === "sidebar";

  return (
    <div ref={rootRef} className={cn("relative", sidebar ? "mt-2" : "min-w-0")}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={pending || !active}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full min-w-0 items-center gap-1 rounded-md text-left transition-colors",
          sidebar
            ? "px-1 py-1 text-xs text-sidebar-foreground/90 hover:bg-sidebar-accent/20"
            : "max-w-[14rem] px-1 py-0.5 text-sm font-medium hover:bg-muted",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {active?.name ?? "Your shop"}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-70" />
      </button>
      {open ? (
        <div
          id={menuId}
          role="listbox"
          aria-label="Switch shop"
          className={cn(
            "absolute z-50 mt-1 min-w-[14rem] overflow-hidden rounded-lg border shadow-lg",
            sidebar
              ? "left-0 border-sidebar-border bg-sidebar text-sidebar-foreground"
              : "left-0 bg-background",
          )}
        >
          <ul className="max-h-64 overflow-y-auto py-1">
            {businesses.map((row) => {
              const selected = row.id === activeId;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={pending}
                    onClick={() => void select(row.id)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                      sidebar
                        ? "hover:bg-sidebar-accent/30"
                        : "hover:bg-muted",
                      selected && (sidebar ? "bg-sidebar-accent/20" : "bg-muted"),
                    )}
                  >
                    <Check
                      className={cn(
                        "size-3.5 shrink-0",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{row.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div
            className={cn(
              "border-t",
              sidebar ? "border-sidebar-border" : "border-border",
            )}
          >
            <Link
              href="/onboarding?add=1"
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm",
                sidebar
                  ? "text-sidebar-foreground/90 hover:bg-sidebar-accent/30"
                  : "hover:bg-muted",
              )}
              onClick={() => setOpen(false)}
            >
              <Plus className="size-3.5 shrink-0" />
              Add another shop
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
