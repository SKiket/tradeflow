import Link from "next/link";

import { getBusinessSellerLanguage } from "@/lib/channels/templates/business-language";
import {
  posterScanLines,
  shareCopy,
} from "@/lib/dashboard/share-copy";
import {
  canAcceptOrders,
  getAcceptOrdersBlockReason,
} from "@/lib/stripe/billing-gate";
import { shopUrl } from "@/lib/storefront/url";

import { requireSeller } from "../require-seller";
import { ShareClient } from "./share-client";

export default async function ShareYourShopPage() {
  const { supabase, businessId, business } = await requireSeller();
  const sellerLang = await getBusinessSellerLanguage(supabase, businessId);
  const copy = shareCopy(sellerLang);
  const scanLines = posterScanLines(sellerLang);

  const [{ data: shareRow }, productsCount] = await Promise.all([
    supabase
      .from("businesses")
      .select(
        "slug, name, whatsapp_phone_e164, closed_at, purge_after, stripe_subscription_status, dispute_balance_hold",
      )
      .eq("id", businessId)
      .maybeSingle(),
    supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("active", true)
      .is("deleted_at", null),
  ]);

  const slug =
    (shareRow?.slug as string | null)?.trim() ||
    (business.slug as string | null)?.trim() ||
    "";
  const name =
    (shareRow?.name as string | null)?.trim() ||
    (business.name as string) ||
    "Shop";
  const phone =
    (shareRow?.whatsapp_phone_e164 as string | null)?.trim() || null;
  const closedAt =
    (shareRow?.closed_at as string | null) ??
    (business.closed_at as string | null) ??
    null;
  const purgeAfter = (shareRow?.purge_after as string | null) ?? null;
  const billing = {
    stripe_subscription_status:
      (shareRow?.stripe_subscription_status as string | null) ??
      (business.stripe_subscription_status as string | null) ??
      null,
    closed_at: closedAt,
    dispute_balance_hold:
      (shareRow?.dispute_balance_hold as boolean | null) ??
      (business.dispute_balance_hold as boolean | null) ??
      false,
  };

  const notLive = Boolean(closedAt || purgeAfter);
  const takingOrders = canAcceptOrders(billing);
  const blockReason = getAcceptOrdersBlockReason(billing);

  const { count: activeCount, error: productError } = productsCount;

  if (productError) {
    return (
      <div className="space-y-2">
        <h1 className="tf-page-heading">{copy.pageTitle}</h1>
        <p className="text-sm text-destructive">{productError.message}</p>
      </div>
    );
  }

  const hasProducts = (activeCount ?? 0) > 0;

  if (notLive) {
    return (
      <div className="mx-auto max-w-xl space-y-3" data-tf-share-not-live>
        <h1 className="tf-page-heading">{copy.pageTitle}</h1>
        <p className="text-base font-medium">{copy.notLiveTitle}</p>
        <p className="text-sm text-muted-foreground">{copy.notLiveBody}</p>
      </div>
    );
  }

  if (!hasProducts) {
    return (
      <div className="mx-auto max-w-xl space-y-3" data-tf-share-no-products>
        <h1 className="tf-page-heading">{copy.pageTitle}</h1>
        <p className="text-base font-medium">{copy.noProductsTitle}</p>
        <p className="text-sm text-muted-foreground">{copy.noProductsBody}</p>
        <Link
          href="/dashboard/products"
          className="inline-flex text-sm font-medium underline-offset-2 hover:underline"
        >
          {copy.goToProducts}
        </Link>
      </div>
    );
  }

  const linkUrl = shopUrl({ slug }, { src: "link" });
  const qrUrl = shopUrl({ slug }, { src: "qr" });
  const socialUrl = shopUrl({ slug }, { src: "social" });
  const ordersPausedReminder =
    !takingOrders && blockReason !== "shop_closed"
      ? copy.ordersPausedReminder
      : null;

  return (
    <div className="space-y-4" data-tf-share-page>
      <div className="mx-auto max-w-xl space-y-1">
        <h1 className="tf-page-heading">{copy.pageTitle}</h1>
        <p className="text-sm text-muted-foreground">{copy.pageIntro}</p>
      </div>
      <ShareClient
        shopName={name}
        linkUrl={linkUrl}
        qrUrl={qrUrl}
        labels={{
          shopLinkHeading: copy.shopLinkHeading,
          copy: copy.copy,
          copied: copy.copied,
          share: copy.share,
          qrHeading: copy.qrHeading,
          downloadPng: copy.downloadPng,
          printPoster: copy.printPoster,
          whatsappHeading: copy.whatsappHeading,
          orderOnWhatsApp: copy.orderOnWhatsApp,
          statusHeading: copy.statusHeading,
          statusPlaceholder: copy.statusPlaceholder,
          shareOnWhatsApp: copy.shareOnWhatsApp,
          socialHeading: copy.socialHeading,
          socialHint: copy.socialHint,
          orderPrefill: copy.orderPrefill,
        }}
        posterScanLines={scanLines}
        whatsappPhoneE164={phone}
        ordersPausedReminder={ordersPausedReminder}
        initialStatusText={copy.statusTemplate(linkUrl)}
        socialBioText={copy.socialBio(socialUrl)}
      />
    </div>
  );
}
