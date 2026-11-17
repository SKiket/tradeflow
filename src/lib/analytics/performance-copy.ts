import type { PerformancePeriodDays } from "./performance-periods";
import type { StatusBucketKey } from "./performance-summarize";

export type PerformanceLang = "en" | "fr";

export function resolvePerformanceLang(
  raw: string | null | undefined,
): PerformanceLang {
  const code = (raw ?? "en").trim().toLowerCase().slice(0, 2);
  return code === "fr" ? "fr" : "en";
}

const COPY = {
  en: {
    title: "Performance",
    subtitle: "How your shop is doing — paid orders, net of refunds.",
    empty: "No sales yet in this period",
    emptyBody: "When buyers pay, your sales and trends will show up here.",
    periodLabel: "Period",
    period: {
      7: "Last 7 days",
      30: "Last 30 days",
      90: "Last 90 days",
    } satisfies Record<PerformancePeriodDays, string>,
    sales: "Sales",
    orders: "Orders",
    aov: "Average order",
    refunds: "Refunds",
    returns: "Returns",
    refundDetail: (amount: string, count: number) =>
      count === 1
        ? `${amount} across 1 order`
        : `${amount} across ${count} orders`,
    returnDetail: (count: number) =>
      count === 1 ? "1 return in progress" : `${count} returns in progress`,
    statusTitle: "Orders by status",
    status: {
      paid: "Paid",
      dispatched: "Dispatched",
      delivered: "Delivered",
      cancelled: "Cancelled",
      refunded: "Refunded",
    } satisfies Record<StatusBucketKey, string>,
    topTitle: "Top products",
    topUnits: (n: number) => (n === 1 ? "1 sold" : `${n} sold`),
    dailyTitle: "Sales by day",
    channelTitle: "Where orders came from",
    whatsapp: "WhatsApp",
    storefront: "Web store",
    other: "Other",
    noPrevious: "no previous data",
    vsPrior: "vs previous period",
    seePerformance: "See performance",
    homeTeaser: (sales: string) => `${sales} in sales recently`,
  },
  fr: {
    title: "Performance",
    subtitle: "Comment va votre boutique — commandes payées, hors remboursements.",
    empty: "Pas encore de ventes sur cette période",
    emptyBody:
      "Quand les acheteurs paient, vos ventes et tendances apparaîtront ici.",
    periodLabel: "Période",
    period: {
      7: "7 derniers jours",
      30: "30 derniers jours",
      90: "90 derniers jours",
    } satisfies Record<PerformancePeriodDays, string>,
    sales: "Ventes",
    orders: "Commandes",
    aov: "Panier moyen",
    refunds: "Remboursements",
    returns: "Retours",
    refundDetail: (amount: string, count: number) =>
      count === 1
        ? `${amount} sur 1 commande`
        : `${amount} sur ${count} commandes`,
    returnDetail: (count: number) =>
      count === 1 ? "1 retour en cours" : `${count} retours en cours`,
    statusTitle: "Commandes par statut",
    status: {
      paid: "Payée",
      dispatched: "Expédiée",
      delivered: "Livrée",
      cancelled: "Annulée",
      refunded: "Remboursée",
    } satisfies Record<StatusBucketKey, string>,
    topTitle: "Meilleurs produits",
    topUnits: (n: number) => (n === 1 ? "1 vendu" : `${n} vendus`),
    dailyTitle: "Ventes par jour",
    channelTitle: "Origine des commandes",
    whatsapp: "WhatsApp",
    storefront: "Boutique web",
    other: "Autre",
    noPrevious: "pas de données précédentes",
    vsPrior: "vs période précédente",
    seePerformance: "Voir la performance",
    homeTeaser: (sales: string) => `${sales} de ventes récemment`,
  },
} as const;

export function performanceCopy(lang: PerformanceLang) {
  return COPY[lang];
}

export function formatChangeLabel(
  changePercent: number | null,
  lang: PerformanceLang,
): { text: string; direction: "up" | "down" | "flat" | "none" } {
  const pack = COPY[lang];
  if (changePercent == null) {
    return { text: pack.noPrevious, direction: "none" };
  }
  if (changePercent === 0) {
    return { text: `0% ${pack.vsPrior}`, direction: "flat" };
  }
  const sign = changePercent > 0 ? "+" : "";
  return {
    text: `${sign}${changePercent}% ${pack.vsPrior}`,
    direction: changePercent > 0 ? "up" : "down",
  };
}
