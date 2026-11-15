import { notifySellerOfDeliveryIssue } from "@/lib/support/notify-seller";
import { deliverOrder } from "@/lib/orders/dispatch-order";
import { ORDER_STATUS } from "@/lib/orders/status";
import { createAdminClient } from "@/lib/supabase/admin";

export interface ShippoHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/** Shippo tracking_status.status values we recognise. */
export type ShippoTrackingStatus =
  | "PRE_TRANSIT"
  | "TRANSIT"
  | "DELIVERED"
  | "RETURNED"
  | "FAILURE"
  | "UNKNOWN";

const KNOWN_STATUSES = new Set<string>([
  "PRE_TRANSIT",
  "TRANSIT",
  "DELIVERED",
  "RETURNED",
  "FAILURE",
  "UNKNOWN",
]);

export type DeliveryIssueKind = "returned" | "failed";

export function mapShippoStatus(raw: unknown): ShippoTrackingStatus {
  const upper = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (KNOWN_STATUSES.has(upper)) return upper as ShippoTrackingStatus;
  return "UNKNOWN";
}

export function normalizeCarrierKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function deliveryIssueKind(
  status: ShippoTrackingStatus,
): DeliveryIssueKind | null {
  if (status === "RETURNED") return "returned";
  if (status === "FAILURE") return "failed";
  return null;
}

/**
 * Processes a verified Shippo webhook body.
 * Only track_updated is handled; unknown events are acknowledged.
 */
export async function handleShippoEvent(
  rawBody: string,
): Promise<ShippoHandlerResult> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { status: 200, body: { ok: true, handled: false, reason: "invalid_json" } };
  }

  const event = typeof parsed.event === "string" ? parsed.event : "";
  if (event !== "track_updated") {
    console.info("[shippo-webhook] Unhandled event type", { type: event || null });
    return {
      status: 200,
      body: { ok: true, handled: false, type: event || null },
    };
  }

  const data =
    parsed.data && typeof parsed.data === "object"
      ? (parsed.data as Record<string, unknown>)
      : parsed;

  const trackingNumber =
    typeof data.tracking_number === "string"
      ? data.tracking_number.trim()
      : "";
  const carrierRaw =
    typeof data.carrier === "string" ? data.carrier.trim() : "";

  const trackingStatusObj =
    data.tracking_status && typeof data.tracking_status === "object"
      ? (data.tracking_status as Record<string, unknown>)
      : null;
  const mapped = mapShippoStatus(trackingStatusObj?.status);
  const statusDateRaw =
    typeof trackingStatusObj?.status_date === "string"
      ? trackingStatusObj.status_date
      : null;
  const statusDate = statusDateRaw ? new Date(statusDateRaw) : null;
  const deliveredAt =
    statusDate && !Number.isNaN(statusDate.getTime()) ? statusDate : new Date();

  if (!trackingNumber || !carrierRaw) {
    console.info("[shippo-webhook] track_updated missing tracking_number/carrier");
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "missing_tracking" },
    };
  }

  const admin = createAdminClient();
  const { data: candidates, error } = await admin
    .from("orders")
    .select(
      "id, order_ref, business_id, status, tracking_status, dispatch_tracking_number, dispatch_carrier",
    )
    .eq("dispatch_tracking_number", trackingNumber)
    .is("deleted_at", null)
    .limit(20);

  if (error) {
    console.error("[shippo-webhook] order lookup failed", { message: error.message });
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "lookup_error" },
    };
  }

  const carrierKey = normalizeCarrierKey(carrierRaw);
  const matches = (candidates ?? []).filter((row) => {
    const stored = (row.dispatch_carrier as string | null)?.trim() ?? "";
    if (!stored) return false;
    return normalizeCarrierKey(stored) === carrierKey;
  });

  if (matches.length === 0) {
    // No information leak — acknowledge without revealing whether the number exists.
    return {
      status: 200,
      body: { ok: true, handled: false, reason: "order_not_found" },
    };
  }

  if (matches.length > 1) {
    console.warn("[shippo-webhook] multiple orders matched tracking+carrier", {
      count: matches.length,
    });
  }

  const order = matches[0]!;
  const previousTracking = (order.tracking_status as string | null) ?? null;
  const nowIso = new Date().toISOString();

  await admin
    .from("orders")
    .update({
      tracking_status: mapped,
      tracking_updated_at: nowIso,
    })
    .eq("id", order.id)
    .eq("business_id", order.business_id);

  const terminal = new Set<string>([
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.REFUNDED,
    ORDER_STATUS.EXPIRED,
  ]);

  if (mapped === "PRE_TRANSIT" || mapped === "TRANSIT" || mapped === "UNKNOWN") {
    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        action: "tracking_stored",
        status: mapped,
        orderId: order.id,
      },
    };
  }

  if (mapped === "DELIVERED") {
    if (terminal.has(order.status as string)) {
      return {
        status: 200,
        body: {
          ok: true,
          handled: true,
          action: "ignored_terminal",
          orderId: order.id,
          status: order.status,
        },
      };
    }

    // Never move backwards: already past DISPATCHED (e.g. DELIVERED+) → no-op notify.
    if (
      order.status === ORDER_STATUS.DELIVERED ||
      order.status === ORDER_STATUS.RETURN_REQUESTED ||
      order.status === ORDER_STATUS.RETURN_APPROVED ||
      order.status === ORDER_STATUS.RETURN_DECLINED ||
      order.status === ORDER_STATUS.RETURNED ||
      order.status === ORDER_STATUS.REFUND_PENDING ||
      order.status === ORDER_STATUS.PARTIALLY_REFUNDED
    ) {
      return {
        status: 200,
        body: {
          ok: true,
          handled: true,
          action: "already_delivered",
          orderId: order.id,
        },
      };
    }

    const outcome = await deliverOrder(admin, order.id as string, {
      deliveredAt,
    });

    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        action: outcome.action,
        orderId: order.id,
      },
    };
  }

  // RETURNED / FAILURE — do not change order status; alert seller once.
  const issue = deliveryIssueKind(mapped);
  if (issue) {
    const alreadyAlerted =
      previousTracking === "RETURNED" || previousTracking === "FAILURE";

    if (!alreadyAlerted && !terminal.has(order.status as string)) {
      await notifySellerOfDeliveryIssue({
        businessId: order.business_id as string,
        orderRef: order.order_ref as string,
        issue,
        supabase: admin,
      });
    }

    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        action: alreadyAlerted ? "issue_already_alerted" : "delivery_issue",
        status: mapped,
        orderId: order.id,
      },
    };
  }

  return {
    status: 200,
    body: { ok: true, handled: true, action: "noop", orderId: order.id },
  };
}
