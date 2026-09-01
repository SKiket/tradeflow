import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { StatusBadge } from "@/components/orders/status-badge";
import {
  formatDateTime,
  formatPence,
  statusLabel,
  unwrapRelation,
} from "@/lib/orders/display";
import { orderTrackingUrl } from "@/lib/storefront/url";
import { createClient } from "@/lib/supabase/server";

import { OrderActions } from "./order-actions";

function shippingLines(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const address = value as Record<string, unknown>;
  return ["line1", "line2", "city", "postcode", "country"]
    .map((key) => address[key])
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => line.trim());
}

interface OrderDetailPageProps {
  params: Promise<{ orderId: string }>;
}

type VariantJoin = {
  label: string | null;
  products: { name: string } | { name: string }[] | null;
} | null;

export default async function OrderDetailPage({ params }: OrderDetailPageProps) {
  const { orderId } = await params;
  const supabase = await createClient();

  const { data: order } = await supabase
    .from("orders")
    .select(
      "id, order_ref, status, total_pence, refunded_amount_pence, stripe_payment_intent_id, dispatch_tracking_number, dispatch_carrier, dispatch_label_url, shipping_address, created_at, channel, customer_id, return_reason, return_reason_detail, return_notes, customers(id, phone_e164, name)",
    )
    .eq("id", orderId)
    .maybeSingle();

  if (!order) notFound();

  const [{ data: items }, { data: history }] = await Promise.all([
    supabase
      .from("order_items")
      .select(
        "id, quantity, unit_price_pence, product_variants(label, products(name))",
      )
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("order_status_history")
      .select("id, from_status, to_status, changed_at")
      .eq("order_id", orderId)
      .order("changed_at", { ascending: true }),
  ]);

  const customer = unwrapRelation(
    order.customers as
      | { id: string; phone_e164: string; name: string | null }
      | { id: string; phone_e164: string; name: string | null }[]
      | null,
  );
  const customerId =
    customer?.id ??
    ((order.customer_id as string | null) ?? null);

  const shipping = shippingLines(order.shipping_address);

  const lines = (items ?? []).map((item) => {
    const variant = unwrapRelation(item.product_variants as VariantJoin | VariantJoin[]);
    const product = unwrapRelation(variant?.products);
    return {
      id: item.id as string,
      productName: product?.name ?? "Item",
      variantLabel: variant?.label ?? null,
      quantity: item.quantity as number,
      unitPricePence: item.unit_price_pence as number,
    };
  });

  const trackingUrl = orderTrackingUrl(order.order_ref as string);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <Link
          href="/dashboard/orders"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to orders
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {order.order_ref as string}
          </h1>
          <StatusBadge status={order.status as string} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Placed {formatDateTime(order.created_at as string)}
          {order.channel ? ` · ${order.channel}` : ""}
        </p>
        <p className="mt-3">
          <a
            href={trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            Buyer tracking page
          </a>
            <span className="mt-1 block break-all text-xs text-muted-foreground">
            {trackingUrl}
          </span>
        </p>
        {(order.dispatch_carrier || order.dispatch_tracking_number) && (
          <p className="mt-1 text-sm text-muted-foreground">
            {order.dispatch_carrier ? String(order.dispatch_carrier) : "Shipped"}
            {order.dispatch_tracking_number
              ? ` · ${String(order.dispatch_tracking_number)}`
              : ""}
          </p>
        )}
        {typeof order.dispatch_label_url === "string" &&
          order.dispatch_label_url.trim() && (
            <p className="mt-3">
              <a
                href={order.dispatch_label_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                View shipping label
              </a>
            </p>
          )}
      </div>

      <OrderActions
        orderId={order.id as string}
        orderRef={order.order_ref as string}
        status={order.status as string}
        totalPence={order.total_pence as number}
        refundedAmountPence={(order.refunded_amount_pence as number) ?? 0}
        hasPaymentIntent={Boolean(order.stripe_payment_intent_id)}
        returnReason={(order.return_reason as string | null) ?? null}
        returnReasonDetail={(order.return_reason_detail as string | null) ?? null}
        returnNotes={(order.return_notes as string | null) ?? null}
      />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Customer
        </h2>
        <dl className="rounded-xl border divide-y">
          <div className="flex justify-between gap-4 px-4 py-3 text-sm">
            <dt className="text-muted-foreground">Phone</dt>
            <dd className="font-medium">
              {customerId && customer?.phone_e164 ? (
                <Link
                  href={`/dashboard/customers/${customerId}`}
                  className="underline-offset-4 hover:underline"
                >
                  {customer.phone_e164}
                </Link>
              ) : (
                (customer?.phone_e164 ?? "—")
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">
              {customerId && customer?.name ? (
                <Link
                  href={`/dashboard/customers/${customerId}`}
                  className="underline-offset-4 hover:underline"
                >
                  {customer.name}
                </Link>
              ) : (
                (customer?.name ?? "—")
              )}
            </dd>
          </div>
          {customerId ? (
            <div className="px-4 py-3 text-sm">
              <Link
                href={`/dashboard/customers/${customerId}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                View customer profile
              </Link>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Delivery address
        </h2>
        {shipping.length === 0 ? (
          <p className="rounded-xl border px-4 py-6 text-sm text-muted-foreground">
            No delivery address captured yet.
          </p>
        ) : (
          <address className="rounded-xl border px-4 py-3 text-sm not-italic leading-6">
            {shipping.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </address>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Items
        </h2>
        {lines.length === 0 ? (
          <p className="rounded-xl border px-4 py-6 text-sm text-muted-foreground">
            No line items on this order.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Variant</th>
                  <th className="px-4 py-3 text-right">Qty</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Line total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-b last:border-b-0">
                    <td className="px-4 py-3 font-medium">{line.productName}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {line.variantLabel ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {line.quantity}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatPence(line.unitPricePence)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatPence(line.unitPricePence * line.quantity)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30">
                  <td colSpan={4} className="px-4 py-3 text-right font-medium">
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {formatPence(order.total_pence as number)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Status history
        </h2>
        {(history ?? []).length === 0 ? (
          <p className="rounded-xl border px-4 py-6 text-sm text-muted-foreground">
            No status changes recorded.
          </p>
        ) : (
          <ol className="rounded-xl border divide-y">
            {(history ?? []).map((entry) => (
              <li
                key={entry.id as string}
                className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <p>
                  {entry.from_status ? (
                    <>
                      <span className="text-muted-foreground">
                        {statusLabel(entry.from_status as string)}
                      </span>
                      {" → "}
                      <span className="font-medium">
                        {statusLabel(entry.to_status as string)}
                      </span>
                    </>
                  ) : (
                    <>
                      Created as{" "}
                      <span className="font-medium">
                        {statusLabel(entry.to_status as string)}
                      </span>
                    </>
                  )}
                </p>
                <time className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDateTime(entry.changed_at as string)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
