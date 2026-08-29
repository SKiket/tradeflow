export type InboxThreadStatus = "needs_reply" | "order_placed" | "general";

export function threadStatusLabel(status: InboxThreadStatus): string {
  switch (status) {
    case "needs_reply":
      return "Needs seller reply";
    case "order_placed":
      return "Order placed";
    default:
      return "General";
  }
}

export function threadStatusClass(status: InboxThreadStatus): string {
  switch (status) {
    case "needs_reply":
      return "bg-amber-100 text-amber-950";
    case "order_placed":
      return "bg-emerald-100 text-emerald-950";
    default:
      return "bg-zinc-100 text-zinc-700";
  }
}

export function parseNeedsSellerReply(parse: unknown): boolean {
  if (!parse || typeof parse !== "object") return false;
  const row = parse as Record<string, unknown>;
  return row.needs_clarification === true || row.escalate_to_seller === true;
}

export function resolveThreadStatus(params: {
  lastInboundParse: unknown;
  hasPlacedOrder: boolean;
}): InboxThreadStatus {
  if (parseNeedsSellerReply(params.lastInboundParse)) {
    return "needs_reply";
  }
  if (params.hasPlacedOrder) return "order_placed";
  return "general";
}
