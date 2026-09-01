import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { ORDER_STATUS } from "@/lib/orders/status";
import { resolveOgImageUrl, shareMetadata } from "@/lib/seo/open-graph";
import { orderTrackingUrl } from "@/lib/storefront/url";
import {
  fetchPublicReturnSlip,
  type PublicReturnSlip,
} from "@/lib/tracking/public-order";

import { PrintSlipButton } from "./print-button";

export const dynamic = "force-dynamic";

interface ReturnSlipPageProps {
  params: Promise<{ orderRef: string }>;
}

const SLIP_STATUSES = new Set<string>([
  ORDER_STATUS.RETURN_APPROVED,
  ORDER_STATUS.RETURNED,
]);

export async function generateMetadata({
  params,
}: ReturnSlipPageProps): Promise<Metadata> {
  const { orderRef } = await params;
  const slip = await fetchPublicReturnSlip(orderRef);
  if (!slip || !SLIP_STATUSES.has(slip.status)) {
    return { title: "Return slip not found" };
  }
  return shareMetadata({
    title: `Return slip ${slip.orderRef}`,
    description: `Return slip for ${slip.orderRef}`,
    url: `${orderTrackingUrl(slip.orderRef)}/return-slip`,
    imageUrl: resolveOgImageUrl(null, null),
    imageAlt: "TradeFlow",
  });
}

export default async function ReturnSlipPage({ params }: ReturnSlipPageProps) {
  await connection();
  const { orderRef } = await params;
  const slip = await fetchPublicReturnSlip(orderRef);
  if (!slip || !SLIP_STATUSES.has(slip.status)) notFound();

  return <ReturnSlipView slip={slip} />;
}

function ReturnSlipView({ slip }: { slip: PublicReturnSlip }) {
  const addressLines = [
    slip.returnAddress.line1,
    slip.returnAddress.city,
    slip.returnAddress.postcode,
  ].filter((line): line is string => Boolean(line));

  return (
    <>
      <style>{`
        @media print {
          @page { margin: 16mm; }
          html, body { background: #fff !important; color: #000 !important; }
          .return-slip-no-print { display: none !important; }
          .return-slip-sheet {
            box-shadow: none !important;
            border: 1px solid #000 !important;
          }
        }
      `}</style>
      <div className="mx-auto min-h-full max-w-lg px-4 py-8 text-zinc-900">
        <div className="return-slip-no-print mb-6 flex items-center justify-between gap-3">
          <a
            href={orderTrackingUrl(slip.orderRef)}
            className="text-sm text-zinc-600 underline-offset-4 hover:underline"
          >
            Back to order
          </a>
          <PrintSlipButton />
        </div>

        <article className="return-slip-sheet rounded-2xl border border-zinc-300 bg-white p-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Return slip
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {slip.orderRef}
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            Enclose this slip with your parcel. You arrange and pay return
            postage.
          </p>

          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Return to
            </h2>
            <address className="mt-2 not-italic leading-6">
              <p className="font-semibold">{slip.businessName}</p>
              {addressLines.length === 0 ? (
                <p>Address not on file — contact the seller.</p>
              ) : (
                addressLines.map((line) => <p key={line}>{line}</p>)
              )}
            </address>
          </section>

          {slip.items.length > 0 ? (
            <section className="mt-6">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Items
              </h2>
              <ul className="mt-2 space-y-1 text-sm">
                {slip.items.map((item, index) => (
                  <li key={`${item.productName}-${index}`}>
                    {item.productName}
                    {item.variantLabel ? ` (${item.variantLabel})` : ""} ×
                    {item.quantity}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </article>
      </div>
    </>
  );
}
