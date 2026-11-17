import type { SellerAttentionItem, SellerAttentionKind } from "./seller-attention";

export type AttentionLang = "en" | "fr";

const COPY = {
  en: {
    title: "Needs your attention",
    allCaughtUp: "All caught up",
    allCaughtUpBody: "Nothing needs your action right now.",
    seeAll: "See all",
    showLess: "Show less",
    labels: {
      disputes: (n: number) =>
        n === 1 ? "1 open dispute" : `${n} open disputes`,
      fraud: (n: number) =>
        n === 1 ? "1 fraud warning" : `${n} fraud warnings`,
      returns: (n: number) =>
        n === 1 ? "1 return to review" : `${n} returns to review`,
      payments_setup: () => "Finish payment setup",
      undispatched: (n: number) =>
        n === 1 ? "1 paid order to dispatch" : `${n} paid orders to dispatch`,
      reminder_failed: (n: number) =>
        n === 1
          ? "1 payment reminder failed"
          : `${n} payment reminders failed`,
      delivery_failed: (n: number) =>
        n === 1
          ? "1 message not delivered"
          : `${n} messages not delivered`,
      low_stock: (n: number) =>
        n === 1 ? "1 product low on stock" : `${n} products low on stock`,
      knowledge_gaps: (n: number) =>
        n === 1
          ? "1 unanswered customer question"
          : `${n} unanswered customer questions`,
    } satisfies Record<SellerAttentionKind, (n: number) => string>,
    reasons: {
      disputes: (detail: string | null) =>
        detail
          ? `Accept or contest before ${formatDeadline(detail, "en")}`
          : "Accept or contest before the deadline",
      fraud: () => "Decide whether to refund",
      returns: () => "Approve or decline the return",
      payments_setup: () => "Buyers cannot pay by card yet",
      undispatched: () => "Mark as sent when you ship",
      reminder_failed: () => "Buyer may not have received the payment link",
      delivery_failed: () => "Check Inbox for messages marked not delivered",
      low_stock: () => "Restock or raise the threshold",
      knowledge_gaps: () => "Add an answer so AI can help next time",
    } satisfies Record<SellerAttentionKind, (detail: string | null) => string>,
  },
  fr: {
    title: "À traiter",
    allCaughtUp: "Tout est à jour",
    allCaughtUpBody: "Rien ne demande votre action pour le moment.",
    seeAll: "Voir tout",
    showLess: "Réduire",
    labels: {
      disputes: (n: number) =>
        n === 1 ? "1 litige ouvert" : `${n} litiges ouverts`,
      fraud: (n: number) =>
        n === 1 ? "1 alerte fraude" : `${n} alertes fraude`,
      returns: (n: number) =>
        n === 1 ? "1 retour à traiter" : `${n} retours à traiter`,
      payments_setup: () => "Terminer la config paiements",
      undispatched: (n: number) =>
        n === 1
          ? "1 commande payée à expédier"
          : `${n} commandes payées à expédier`,
      reminder_failed: (n: number) =>
        n === 1
          ? "1 rappel de paiement échoué"
          : `${n} rappels de paiement échoués`,
      delivery_failed: (n: number) =>
        n === 1
          ? "1 message non livré"
          : `${n} messages non livrés`,
      low_stock: (n: number) =>
        n === 1 ? "1 produit en stock bas" : `${n} produits en stock bas`,
      knowledge_gaps: (n: number) =>
        n === 1
          ? "1 question client sans réponse"
          : `${n} questions clients sans réponse`,
    } satisfies Record<SellerAttentionKind, (n: number) => string>,
    reasons: {
      disputes: (detail: string | null) =>
        detail
          ? `Accepter ou contester avant le ${formatDeadline(detail, "fr")}`
          : "Accepter ou contester avant la deadline",
      fraud: () => "Décider s’il faut rembourser",
      returns: () => "Approuver ou refuser le retour",
      payments_setup: () => "Les acheteurs ne peuvent pas payer par carte",
      undispatched: () => "Marquez comme envoyé à l’expédition",
      reminder_failed: () =>
        "L’acheteur n’a peut‑être pas reçu le lien de paiement",
      delivery_failed: () =>
        "Vérifiez la boîte de réception pour les non‑livrés",
      low_stock: () => "Réapprovisionnez ou augmentez le seuil",
      knowledge_gaps: () =>
        "Ajoutez une réponse pour aider l’IA la prochaine fois",
    } satisfies Record<SellerAttentionKind, (detail: string | null) => string>,
  },
} as const;

function formatDeadline(iso: string, lang: AttentionLang): string {
  try {
    return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function resolveAttentionLang(
  raw: string | null | undefined,
): AttentionLang {
  const code = (raw ?? "en").trim().toLowerCase().slice(0, 2);
  return code === "fr" ? "fr" : "en";
}

export function formatAttentionRow(
  item: SellerAttentionItem,
  lang: AttentionLang,
): { label: string; reason: string } {
  const pack = COPY[lang];
  return {
    label: pack.labels[item.kind](item.count),
    reason: pack.reasons[item.kind](item.detail),
  };
}

export function attentionUiCopy(lang: AttentionLang) {
  const pack = COPY[lang];
  return {
    title: pack.title,
    allCaughtUp: pack.allCaughtUp,
    allCaughtUpBody: pack.allCaughtUpBody,
    seeAll: pack.seeAll,
    showLess: pack.showLess,
  };
}
