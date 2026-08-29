"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

export function ActiveToggle({
  productId,
  active,
}: {
  productId: string;
  active: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState(active);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(active);
  }, [active]);

  async function toggle(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    setPending(true);
    setError(null);
    const next = !value;
    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("products")
      .update({ active: next })
      .eq("id", productId);
    setPending(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setValue(next);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      title={error ?? (value ? "Deactivate product" : "Activate product")}
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        value ? "bg-emerald-100 text-emerald-950" : "bg-zinc-100 text-zinc-600",
      )}
      aria-pressed={value}
    >
      {value ? "Active" : "Inactive"}
      {error ? <span className="sr-only">{error}</span> : null}
    </button>
  );
}
