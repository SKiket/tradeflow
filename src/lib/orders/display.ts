import { ORDER_STATUS } from "@/lib/orders/status";

/** Statuses shown in the seller dashboard (excludes unused legacy PENDING). */
export const SELLER_STATUSES = [
  ORDER_STATUS.PENDING_CONFIRMATION,
  ORDER_STATUS.AWAITING_PAYMENT,
  ORDER_STATUS.PAID,
  ORDER_STATUS.DISPATCHED,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.REFUND_PENDING,
  ORDER_STATUS.PARTIALLY_REFUNDED,
  ORDER_STATUS.REFUNDED,
  ORDER_STATUS.PAYMENT_FAILED,
  ORDER_STATUS.EXPIRED,
  ORDER_STATUS.CANCELLED,
] as const;

export type SellerStatus = (typeof SELLER_STATUSES)[number];

const STATUS_LABELS: Record<string, string> = {
  [ORDER_STATUS.PENDING_CONFIRMATION]: "Pending confirmation",
  [ORDER_STATUS.AWAITING_PAYMENT]: "Awaiting payment",
  [ORDER_STATUS.PAID]: "Paid",
  [ORDER_STATUS.DISPATCHED]: "Dispatched",
  [ORDER_STATUS.DELIVERED]: "Delivered",
  [ORDER_STATUS.REFUND_PENDING]: "Refund pending",
  [ORDER_STATUS.PARTIALLY_REFUNDED]: "Partially refunded",
  [ORDER_STATUS.REFUNDED]: "Refunded",
  [ORDER_STATUS.PAYMENT_FAILED]: "Payment failed",
  [ORDER_STATUS.EXPIRED]: "Expired",
  [ORDER_STATUS.CANCELLED]: "Cancelled",
  [ORDER_STATUS.PENDING]: "Pending",
};

/** Distinct badge colours so a seller can scan status at a glance. */
const STATUS_BADGE: Record<string, string> = {
  [ORDER_STATUS.PENDING_CONFIRMATION]: "bg-amber-100 text-amber-950",
  [ORDER_STATUS.AWAITING_PAYMENT]: "bg-sky-100 text-sky-950",
  [ORDER_STATUS.PAID]: "bg-emerald-100 text-emerald-950",
  [ORDER_STATUS.DISPATCHED]: "bg-indigo-100 text-indigo-950",
  [ORDER_STATUS.DELIVERED]: "bg-teal-100 text-teal-950",
  [ORDER_STATUS.REFUND_PENDING]: "bg-orange-100 text-orange-950",
  [ORDER_STATUS.PARTIALLY_REFUNDED]: "bg-violet-100 text-violet-950",
  [ORDER_STATUS.REFUNDED]: "bg-rose-100 text-rose-950",
  [ORDER_STATUS.PAYMENT_FAILED]: "bg-red-100 text-red-950",
  [ORDER_STATUS.EXPIRED]: "bg-stone-200 text-stone-800",
  [ORDER_STATUS.CANCELLED]: "bg-zinc-100 text-zinc-600",
  [ORDER_STATUS.PENDING]: "bg-zinc-100 text-zinc-700",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

export function statusBadgeClass(status: string): string {
  return STATUS_BADGE[status] ?? "bg-zinc-100 text-zinc-700";
}

export function formatPence(pence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}

export function formatDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("day")} ${value("month")} ${value("year")}, ${value("hour")}:${value("minute")}`;
}

/** Supabase nested selects may return an object or a single-element array. */
export function unwrapRelation<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
