import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { LegalLinks } from "@/components/brand/legal-links";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "TradeFlow",
  description: "Sell on WhatsApp. Get paid. Stay in control.",
};

const COPY = {
  en: {
    tagline: "Sell on WhatsApp. Get paid. Stay in control.",
    signIn: "Sign in",
  },
  fr: {
    tagline: "Vendez sur WhatsApp. Soyez payé. Gardez le contrôle.",
    signIn: "Se connecter",
  },
} as const;

function resolveLang(acceptLanguage: string | null): "en" | "fr" {
  const primary = (acceptLanguage ?? "en").split(",")[0]?.trim().toLowerCase() ?? "en";
  return primary.startsWith("fr") ? "fr" : "en";
}

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  const headerStore = await headers();
  const lang = resolveLang(headerStore.get("accept-language"));
  const copy = COPY[lang];

  return (
    <main
      data-tf-home
      className="flex flex-1 flex-col items-center justify-center bg-background px-6 py-16"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
        <div className="space-y-4">
          <img
            src="/brand/tradeflow-wordmark-navy.svg"
            alt="TradeFlow"
            className="mx-auto h-9 w-auto"
          />
          <h1 className="sr-only">TradeFlow</h1>
          <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
            {copy.tagline}
          </p>
        </div>

        <Link
          href="/login"
          data-tf-home-signin
          className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-[var(--btn-primary-hover,color-mix(in_oklch,var(--primary),transparent_20%))]"
        >
          {copy.signIn}
        </Link>

        <LegalLinks
          className="text-xs text-muted-foreground"
          linkClassName="underline-offset-2 hover:underline"
        />
      </div>
    </main>
  );
}
