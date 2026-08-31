"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type CartLine = {
  variantId: string;
  quantity: number;
};

type CartContextValue = {
  slug: string;
  lines: CartLine[];
  hydrated: boolean;
  add: (variantId: string, quantity?: number) => void;
  setQuantity: (variantId: string, quantity: number) => void;
  remove: (variantId: string) => void;
  clear: () => void;
  itemCount: number;
};

const CartContext = createContext<CartContextValue | null>(null);

function storageKey(slug: string): string {
  return `tradeflow-cart:${slug}`;
}

function readStored(slug: string): CartLine[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(storageKey(slug));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        const variantId =
          row && typeof row === "object" && "variantId" in row
            ? String((row as CartLine).variantId)
            : "";
        const quantity = Math.floor(Number((row as CartLine).quantity));
        if (!variantId || !Number.isFinite(quantity) || quantity < 1) {
          return null;
        }
        return { variantId, quantity };
      })
      .filter((row): row is CartLine => row !== null);
  } catch {
    return [];
  }
}

function writeStored(slug: string, lines: CartLine[]): void {
  try {
    sessionStorage.setItem(storageKey(slug), JSON.stringify(lines));
  } catch {
    // Private mode / quota — cart still works for this page session.
  }
}

export function CartProvider({
  slug,
  children,
}: {
  slug: string;
  children: React.ReactNode;
}) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setLines(readStored(slug));
    setHydrated(true);
  }, [slug]);

  const persist = useCallback(
    (updater: CartLine[] | ((current: CartLine[]) => CartLine[])) => {
      setLines((current) => {
        const next = typeof updater === "function" ? updater(current) : updater;
        writeStored(slug, next);
        return next;
      });
    },
    [slug],
  );

  const add = useCallback(
    (variantId: string, quantity = 1) => {
      persist((current) => {
        const existing = current.find((line) => line.variantId === variantId);
        if (!existing) {
          return [...current, { variantId, quantity }];
        }
        return current.map((line) =>
          line.variantId === variantId
            ? { ...line, quantity: Math.min(99, line.quantity + quantity) }
            : line,
        );
      });
    },
    [persist],
  );

  const setQuantity = useCallback(
    (variantId: string, quantity: number) => {
      const nextQty = Math.floor(quantity);
      persist((current) => {
        if (!Number.isFinite(nextQty) || nextQty < 1) {
          return current.filter((line) => line.variantId !== variantId);
        }
        return current.map((line) =>
          line.variantId === variantId
            ? { ...line, quantity: Math.min(99, nextQty) }
            : line,
        );
      });
    },
    [persist],
  );

  const remove = useCallback(
    (variantId: string) => {
      persist((current) => current.filter((line) => line.variantId !== variantId));
    },
    [persist],
  );

  const clear = useCallback(() => {
    persist([]);
  }, [persist]);

  const itemCount = useMemo(
    () => lines.reduce((sum, line) => sum + line.quantity, 0),
    [lines],
  );

  const value = useMemo(
    () => ({
      slug,
      lines,
      hydrated,
      add,
      setQuantity,
      remove,
      clear,
      itemCount,
    }),
    [slug, lines, hydrated, add, setQuantity, remove, clear, itemCount],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (!value) {
    throw new Error("useCart must be used within CartProvider");
  }
  return value;
}
