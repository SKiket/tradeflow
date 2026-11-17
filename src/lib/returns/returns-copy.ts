import type { ReturnReason } from "@/lib/orders/return-reasons";
import { isReturnReason } from "@/lib/orders/return-reasons";

import type { ReturnsRefundStatus, ReturnsTab } from "./list-returns";

export type ReturnsLang = "en" | "fr";

export function resolveReturnsLang(
  raw: string | null | undefined,
): ReturnsLang {
  const code = (raw ?? "en").trim().toLowerCase().slice(0, 2);
  return code === "fr" ? "fr" : "en";
}

const COPY = {
  en: {
    title: "Returns",
    subtitle: "Review return requests. Open an order to approve, decline, or refund.",
    tabs: {
      needs_decision: "Needs decision",
      approved: "Approved",
      declined: "Declined",
      closed: "Refunded / closed",
    } satisfies Record<ReturnsTab, string>,
    empty: {
      needs_decision: "Nothing waiting for a decision",
      approved: "No approved returns waiting",
      declined: "No declined returns",
      closed: "No closed returns yet",
    } satisfies Record<ReturnsTab, string>,
    emptyBody: "When a buyer asks to return something, it will show up here.",
    items: "Items",
    reason: "Reason",
    requested: "Requested",
    waited: "Waiting",
    refund: "Refund",
    refundNone: "No refund",
    refundPartial: "Partial refund",
    refundFull: "Fully refunded",
    day: (n: number) => (n === 1 ? "1 day" : `${n} days`),
    hour: (n: number) => (n === 1 ? "1 hour" : `${n} hours`),
    justNow: "Just now",
    prev: "Previous",
    next: "Next",
    pageOf: (page: number, pages: number) => `Page ${page} of ${pages}`,
    reasons: {
      wrong_size: "Wrong size",
      damaged_faulty: "Arrived damaged",
      changed_mind: "Changed mind",
      not_as_described: "Not as described",
      arrived_late: "Arrived late",
      other: "Other",
    } satisfies Record<ReturnReason, string>,
  },
  fr: {
    title: "Retours",
    subtitle:
      "Traitez les demandes de retour. Ouvrez une commande pour approuver, refuser ou rembourser.",
    tabs: {
      needs_decision: "À traiter",
      approved: "Approuvés",
      declined: "Refusés",
      closed: "Remboursés / clos",
    } satisfies Record<ReturnsTab, string>,
    empty: {
      needs_decision: "Rien à traiter",
      approved: "Aucun retour approuvé en attente",
      declined: "Aucun retour refusé",
      closed: "Aucun retour clos pour le moment",
    } satisfies Record<ReturnsTab, string>,
    emptyBody:
      "Quand un acheteur demande un retour, il apparaîtra ici.",
    items: "Articles",
    reason: "Motif",
    requested: "Demandé",
    waited: "En attente",
    refund: "Remboursement",
    refundNone: "Pas de remboursement",
    refundPartial: "Remboursement partiel",
    refundFull: "Entièrement remboursé",
    day: (n: number) => (n === 1 ? "1 jour" : `${n} jours`),
    hour: (n: number) => (n === 1 ? "1 heure" : `${n} heures`),
    justNow: "À l’instant",
    prev: "Précédent",
    next: "Suivant",
    pageOf: (page: number, pages: number) => `Page ${page} sur ${pages}`,
    reasons: {
      wrong_size: "Mauvaise taille",
      damaged_faulty: "Arrivé endommagé",
      changed_mind: "Changement d’avis",
      not_as_described: "Non conforme",
      arrived_late: "Arrivé en retard",
      other: "Autre",
    } satisfies Record<ReturnReason, string>,
  },
} as const;

export function returnsCopy(lang: ReturnsLang) {
  return COPY[lang];
}

export function formatReturnReasonLabel(
  reason: string | null,
  detail: string | null,
  lang: ReturnsLang,
): string {
  const pack = COPY[lang];
  const base = isReturnReason(reason)
    ? pack.reasons[reason]
    : reason?.trim() || pack.reasons.other;
  const extra = detail?.trim();
  if (!extra) return base;
  const clipped = extra.length > 80 ? `${extra.slice(0, 77)}…` : extra;
  return `${base}: ${clipped}`;
}

export function formatWaited(
  requestedAt: string | null,
  lang: ReturnsLang,
  now = new Date(),
): string {
  const pack = COPY[lang];
  if (!requestedAt) return "—";
  const ms = now.getTime() - new Date(requestedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return pack.justNow;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return pack.justNow;
  if (hours < 48) return pack.hour(hours);
  return pack.day(Math.floor(hours / 24));
}

export function formatRequestedDate(
  iso: string | null,
  lang: ReturnsLang,
): string {
  if (!iso) return "—";
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

export function refundStatusLabel(
  status: ReturnsRefundStatus,
  lang: ReturnsLang,
): string {
  const pack = COPY[lang];
  if (status === "full") return pack.refundFull;
  if (status === "partial") return pack.refundPartial;
  return pack.refundNone;
}
