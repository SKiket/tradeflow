import type { InventoryMovementReason, InventoryMovementRow } from "./movements";

export type InventoryLang = "en" | "fr";

export function resolveInventoryLang(
  raw: string | null | undefined,
): InventoryLang {
  const code = (raw ?? "en").trim().toLowerCase().slice(0, 2);
  return code === "fr" ? "fr" : "en";
}

const COPY = {
  en: {
    title: "Stock history",
    starts: "History starts 17 Nov 2026",
    empty: "No stock changes recorded yet",
    loadMore: "Load more",
    stockAfter: (n: number) => `Stock now ${n}`,
    reasons: {
      sale: (orderRef: string | null) =>
        orderRef ? `Sold, order ${orderRef}` : "Sold",
      restock_cancellation: (orderRef: string | null) =>
        orderRef
          ? `Returned to stock (cancelled order ${orderRef})`
          : "Returned to stock (cancellation)",
      restock_return: (orderRef: string | null) =>
        orderRef
          ? `Returned to stock, order ${orderRef}`
          : "Returned to stock",
      manual_adjustment: () => "You changed stock",
      initial: () => "Starting stock",
      other: () => "Stock updated",
    } satisfies Record<
      InventoryMovementReason,
      (orderRef: string | null) => string
    >,
  },
  fr: {
    title: "Historique du stock",
    starts: "L’historique commence le 17 nov. 2026",
    empty: "Aucun mouvement de stock enregistré",
    loadMore: "Voir plus",
    stockAfter: (n: number) => `Stock : ${n}`,
    reasons: {
      sale: (orderRef: string | null) =>
        orderRef ? `Vendu, commande ${orderRef}` : "Vendu",
      restock_cancellation: (orderRef: string | null) =>
        orderRef
          ? `Remis en stock (commande annulée ${orderRef})`
          : "Remis en stock (annulation)",
      restock_return: (orderRef: string | null) =>
        orderRef
          ? `Remis en stock, commande ${orderRef}`
          : "Remis en stock",
      manual_adjustment: () => "Vous avez modifié le stock",
      initial: () => "Stock initial",
      other: () => "Stock mis à jour",
    } satisfies Record<
      InventoryMovementReason,
      (orderRef: string | null) => string
    >,
  },
} as const;

export function inventoryCopy(lang: InventoryLang) {
  return COPY[lang];
}

export function formatMovementLine(
  row: InventoryMovementRow,
  lang: InventoryLang,
): { change: string; reason: string; when: string; stockAfter: string } {
  const pack = COPY[lang];
  const sign = row.change > 0 ? `+${row.change}` : String(row.change);
  let when = row.createdAt.slice(0, 10);
  try {
    when = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(row.createdAt));
  } catch {
    /* keep iso date */
  }
  return {
    change: sign,
    reason: pack.reasons[row.reason](row.orderRef),
    when,
    stockAfter: pack.stockAfter(row.stockAfter),
  };
}
