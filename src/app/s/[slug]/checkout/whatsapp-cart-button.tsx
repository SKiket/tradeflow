"use client";

import { useEffect, useMemo, useState } from "react";

import {
  buildWhatsAppCartLink,
  type WhatsAppCartLine,
} from "@/lib/storefront/whatsapp-cart";
import type { PublicStorefront } from "@/lib/storefront/catalog";

function browsingLang(): "en" | "fr" {
  if (typeof window === "undefined") return "en";
  const raw =
    (typeof document !== "undefined" && document.documentElement.lang) ||
    navigator.language ||
    (navigator.languages && navigator.languages[0]) ||
    "en";
  return raw.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function WhatsAppCartButton({
  storefront,
  lines,
}: {
  storefront: PublicStorefront;
  lines: WhatsAppCartLine[];
}) {
  const show =
    Boolean(storefront.whatsappPhoneE164) && storefront.takingOrders;
  const [lang, setLang] = useState<"en" | "fr">("en");
  useEffect(() => {
    setLang(browsingLang());
  }, []);

  const built = useMemo(() => {
    if (!show || !storefront.whatsappPhoneE164) return null;
    return buildWhatsAppCartLink({
      phoneOrLink: storefront.whatsappPhoneE164,
      lines,
      lang,
    });
  }, [show, storefront.whatsappPhoneE164, lines, lang]);

  if (!show) return null;

  if (!built || !built.ok) {
    const note =
      built?.reason === "too_many_lines" || built?.reason === "url_too_long"
        ? "This cart is too large for WhatsApp — please use web checkout below."
        : "WhatsApp order isn’t available for this cart — please use web checkout.";
    return (
      <p
        role="status"
        className="rounded-[12px] border border-[var(--tf-border)] bg-[var(--tf-bg-page)] px-3 py-2 text-sm text-[var(--tf-text-secondary)]"
      >
        {note}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <a
        href={built.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-11 w-full items-center justify-center rounded-[12px] border border-[var(--tf-border)] bg-[var(--tf-bg-surface)] px-3 text-sm font-semibold text-[var(--tf-text)] hover:bg-[var(--tf-bg-page)]"
      >
        Order these on WhatsApp
      </a>
      <p className="text-sm leading-5 text-[var(--tf-text-secondary)]">
        Send the message in WhatsApp to place your order.
      </p>
    </div>
  );
}
