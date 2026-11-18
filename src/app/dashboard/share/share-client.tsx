"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { whatsappDigitsFromPhoneOrLink } from "@/lib/storefront/whatsapp-cart";

/** Serializable labels only — no functions (RSC → client). */
export type ShareClientLabels = {
  shopLinkHeading: string;
  copy: string;
  copied: string;
  share: string;
  qrHeading: string;
  downloadPng: string;
  printPoster: string;
  whatsappHeading: string;
  orderOnWhatsApp: string;
  statusHeading: string;
  statusPlaceholder: string;
  shareOnWhatsApp: string;
  socialHeading: string;
  socialHint: string;
  orderPrefill: string;
};

type ShareClientProps = {
  shopName: string;
  linkUrl: string;
  qrUrl: string;
  labels: ShareClientLabels;
  posterScanLines: string[];
  whatsappPhoneE164: string | null;
  ordersPausedReminder: string | null;
  initialStatusText: string;
  socialBioText: string;
};

export function ShareClient(props: ShareClientProps) {
  const {
    shopName,
    linkUrl,
    qrUrl,
    labels,
    posterScanLines,
    whatsappPhoneE164,
    ordersPausedReminder,
    initialStatusText,
    socialBioText,
  } = props;

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const [svgMarkup, setSvgMarkup] = useState<string>("");
  const [statusText, setStatusText] = useState(initialStatusText);
  const printRef = useRef<HTMLDivElement>(null);

  const waDigits = useMemo(
    () =>
      whatsappPhoneE164
        ? whatsappDigitsFromPhoneOrLink(whatsappPhoneE164)
        : null,
    [whatsappPhoneE164],
  );

  const orderWaUrl = useMemo(() => {
    if (!waDigits) return null;
    return `https://wa.me/${waDigits}?text=${encodeURIComponent(labels.orderPrefill)}`;
  }, [waDigits, labels.orderPrefill]);

  const statusWaUrl = useMemo(() => {
    return `https://wa.me/?text=${encodeURIComponent(statusText)}`;
  }, [statusText]);

  useEffect(() => {
    setCanNativeShare(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(qrUrl, {
      type: "svg",
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#FFFFFF" },
    })
      .then((svg) => {
        if (!cancelled) setSvgMarkup(svg);
      })
      .catch(() => {
        if (!cancelled) setSvgMarkup("");
      });
    return () => {
      cancelled = true;
    };
  }, [qrUrl]);

  const flashCopied = useCallback((key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1600);
  }, []);

  const copyText = useCallback(
    async (key: string, text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        flashCopied(key);
      } catch {
        // Fallback for older browsers / denied clipboard.
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        flashCopied(key);
      }
    },
    [flashCopied],
  );

  const onNativeShare = useCallback(async () => {
    if (!navigator.share) return;
    try {
      await navigator.share({ title: shopName, url: linkUrl, text: shopName });
    } catch {
      /* user cancelled */
    }
  }, [shopName, linkUrl]);

  const downloadPng = useCallback(async () => {
    const dataUrl = await QRCode.toDataURL(qrUrl, {
      margin: 2,
      width: 1024,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#FFFFFF" },
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${shopName.replace(/[^\w\-]+/g, "-").toLowerCase() || "shop"}-qr.png`;
    a.click();
  }, [qrUrl, shopName]);

  const printPoster = useCallback(() => {
    window.print();
  }, []);

  return (
    <div className="mx-auto max-w-xl space-y-8">
      {ordersPausedReminder ? (
        <p
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          data-tf-share-orders-paused
        >
          {ordersPausedReminder}
        </p>
      ) : null}

      <section className="space-y-3" data-tf-share-link>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.shopLinkHeading}
        </h2>
        <p className="break-all text-lg font-medium leading-snug sm:text-xl">
          {linkUrl}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => void copyText("link", linkUrl)}
            data-tf-share-copy-link
          >
            {copiedKey === "link" ? labels.copied : labels.copy}
          </Button>
          {canNativeShare ? (
            <Button type="button" variant="outline" onClick={() => void onNativeShare()}>
              {labels.share}
            </Button>
          ) : null}
        </div>
      </section>

      <section className="space-y-3" data-tf-share-qr>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.qrHeading}
        </h2>
        <div
          className="mx-auto w-full max-w-[220px] rounded-lg border bg-white p-3 [&_svg]:h-auto [&_svg]:w-full"
          data-tf-share-qr-svg
          // SVG from qrcode is local-generated (no third-party).
          dangerouslySetInnerHTML={svgMarkup ? { __html: svgMarkup } : undefined}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void downloadPng()}>
            {labels.downloadPng}
          </Button>
          <Button type="button" variant="outline" onClick={printPoster}>
            {labels.printPoster}
          </Button>
        </div>
      </section>

      {orderWaUrl ? (
        <section className="space-y-3" data-tf-share-whatsapp>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {labels.whatsappHeading}
          </h2>
          <div className="space-y-2">
            <Label>{labels.orderOnWhatsApp}</Label>
            <p className="break-all text-sm text-muted-foreground">{orderWaUrl}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void copyText("order-wa", orderWaUrl)}
            >
              {copiedKey === "order-wa" ? labels.copied : labels.copy}
            </Button>
          </div>
          <div className="space-y-2 pt-2">
            <Label htmlFor="share-status">{labels.statusHeading}</Label>
            <p className="text-xs text-muted-foreground">{labels.statusPlaceholder}</p>
            <textarea
              id="share-status"
              value={statusText}
              onChange={(event) => setStatusText(event.target.value)}
              rows={3}
              className="flex min-h-[80px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void copyText("status", statusText)}
              >
                {copiedKey === "status" ? labels.copied : labels.copy}
              </Button>
              <a
                href={statusWaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground"
              >
                {labels.shareOnWhatsApp}
              </a>
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-3" data-tf-share-social>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.socialHeading}
        </h2>
        <p className="text-xs text-muted-foreground">{labels.socialHint}</p>
        <Input readOnly value={socialBioText} className="text-sm" />
        <Button
          type="button"
          variant="outline"
          onClick={() => void copyText("social", socialBioText)}
        >
          {copiedKey === "social" ? labels.copied : labels.copy}
        </Button>
      </section>

      {/* Print-only poster (A4, B&W friendly). Hidden on screen. */}
      <div
        ref={printRef}
        className="hidden print:block"
        data-tf-share-poster
      >
        <div className="mx-auto flex min-h-[100vh] max-w-[180mm] flex-col items-center justify-center gap-6 px-8 py-12 text-center text-black">
          <h1 className="text-3xl font-semibold tracking-tight">{shopName}</h1>
          <div
            className="w-[55mm] [&_svg]:h-auto [&_svg]:w-full"
            dangerouslySetInnerHTML={svgMarkup ? { __html: svgMarkup } : undefined}
          />
          <div className="space-y-1 text-base">
            {posterScanLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <p className="break-all text-sm">{qrUrl}</p>
        </div>
      </div>

      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          [data-tf-share-poster],
          [data-tf-share-poster] * { visibility: visible !important; }
          [data-tf-share-poster] {
            position: absolute;
            inset: 0;
            display: block !important;
          }
          @page { size: A4; margin: 12mm; }
        }
      `}</style>
    </div>
  );
}
