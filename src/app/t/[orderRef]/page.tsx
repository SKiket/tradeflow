import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { PoweredByTradeFlow } from "@/components/brand/powered-by";
import { tenantAccentStyle } from "@/lib/brand/accent";
import {
  formatDateTime,
  formatPence,
  statusLabel,
} from "@/lib/orders/display";
import { ORDER_STATUS } from "@/lib/orders/status";
import {
  fetchPublicTrackingOrder,
  type PublicTrackingOrder,
} from "@/lib/tracking/public-order";

export const dynamic = "force-dynamic";

interface TrackingPageProps {
  params: Promise<{ orderRef: string }>;
}

const MILESTONES: Array<{ label: string; reached: ReadonlySet<string> }> = [
  {
    label: "Order placed",
    reached: new Set([
      ORDER_STATUS.PENDING_CONFIRMATION,
      ORDER_STATUS.AWAITING_PAYMENT,
      ORDER_STATUS.PAID,
      ORDER_STATUS.DISPATCHED,
      ORDER_STATUS.DELIVERED,
    ]),
  },
  {
    label: "Paid",
    reached: new Set([
      ORDER_STATUS.PAID,
      ORDER_STATUS.DISPATCHED,
      ORDER_STATUS.DELIVERED,
    ]),
  },
  {
    label: "Dispatched",
    reached: new Set([ORDER_STATUS.DISPATCHED, ORDER_STATUS.DELIVERED]),
  },
  {
    label: "Delivered",
    reached: new Set([ORDER_STATUS.DELIVERED]),
  },
];

export async function generateMetadata({
  params,
}: TrackingPageProps): Promise<Metadata> {
  const { orderRef } = await params;
  const order = await fetchPublicTrackingOrder(orderRef);
  if (!order) {
    return { title: "Order not found" };
  }
  return {
    title: `Track ${order.orderRef}`,
    description: `Status: ${statusLabel(order.status)}`,
  };
}

export default async function TrackingPage({ params }: TrackingPageProps) {
  await connection();
  const { orderRef } = await params;
  const order = await fetchPublicTrackingOrder(orderRef);
  if (!order) notFound();

  return <TrackingView order={order} />;
}

function TrackingView({ order }: { order: PublicTrackingOrder }) {
  const refunded = order.refundedAmountPence > 0;
  const delivered = order.status === ORDER_STATUS.DELIVERED;

  return (
    <div
      data-tf-surface="storefront"
      className="mx-auto min-h-full max-w-lg px-4 py-8"
      style={tenantAccentStyle(order.accentColor)}
    >
      <header className="flex items-start gap-3">
        {order.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={order.logoUrl}
            alt=""
            className="size-12 shrink-0 rounded-2xl object-cover ring-1 ring-zinc-200"
          />
        ) : null}
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-700">{order.businessName}</p>
          <h1 className="tf-page-heading mt-1">{order.orderRef}</h1>
          <p className="mt-1 text-sm text-zinc-600">
            {statusLabel(order.status)} · placed {formatDateTime(order.createdAt)}
          </p>
        </div>
      </header>

      <ol className="mt-6 grid grid-cols-4 gap-2">
        {MILESTONES.map((step) => {
          const done = step.reached.has(order.status);
          const isDeliveredStep = step.label === "Delivered";
          return (
            <li key={step.label} className="text-center">
              <span
                className={`mx-auto block size-3 rounded-full ${
                  done && isDeliveredStep && delivered
                    ? "bg-[var(--tf-accent-mint)]"
                    : done
                      ? "bg-zinc-900"
                      : "bg-zinc-300"
                }`}
              />
              <p
                className={`mt-2 text-[11px] leading-4 ${
                  done ? "font-medium text-zinc-900" : "text-zinc-400"
                }`}
              >
                {step.label}
              </p>
            </li>
          );
        })}
      </ol>

      {order.shipment?.trackingNumber ? (
        <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Tracking
          </p>
          {order.shipment.carrier ? (
            <p className="mt-1 text-sm text-zinc-600">{order.shipment.carrier}</p>
          ) : null}
          {order.shipment.trackingUrl ? (
            <a
              href={order.shipment.trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 block break-all text-base font-semibold text-zinc-900 underline-offset-4 hover:underline"
            >
              {order.shipment.trackingNumber}
            </a>
          ) : (
            <p className="mt-2 break-all text-base font-semibold">
              {order.shipment.trackingNumber}
            </p>
          )}
          {order.shipment.trackingUrl ? (
            <a
              href={order.shipment.trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="tf-storefront-cta mt-3 inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold"
            >
              Track with {order.shipment.carrier ?? "carrier"}
            </a>
          ) : null}
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Items
        </h2>
        {order.items.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600">No items on this order.</p>
        ) : (
          <ul className="mt-2 divide-y rounded-2xl border border-zinc-200 bg-white">
            {order.items.map((item, index) => (
              <li
                key={`${item.productName}-${item.variantLabel ?? "default"}-${index}`}
                className="flex justify-between gap-3 px-4 py-3 text-sm"
              >
                <p>
                  <span className="font-medium">{item.productName}</span>
                  {item.variantLabel ? (
                    <span className="text-zinc-600"> ({item.variantLabel})</span>
                  ) : null}
                </p>
                <p className="tabular-nums text-zinc-600">×{item.quantity}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-right text-sm font-semibold">
          Total {formatPence(order.totalPence)}
        </p>
        {refunded ? (
          <p className="mt-1 text-right text-sm text-zinc-600">
            Refunded {formatPence(order.refundedAmountPence)}
          </p>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Status timeline
        </h2>
        {order.history.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600">No status updates yet.</p>
        ) : (
          <ol className="mt-2 divide-y rounded-2xl border border-zinc-200 bg-white">
            {order.history.map((event, index) => (
              <li
                key={`${event.status}-${event.at}-${index}`}
                className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <p className="font-medium">{statusLabel(event.status)}</p>
                <time className="text-xs text-zinc-500 whitespace-nowrap">
                  {formatDateTime(event.at)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <PoweredByTradeFlow />
    </div>
  );
}
