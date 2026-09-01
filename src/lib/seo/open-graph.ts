import type { Metadata } from "next";

import { publicAppOrigin } from "@/lib/storefront/url";

export const DEFAULT_OG_IMAGE_PATH = "/og/default";

export function defaultOgImageUrl(): string {
  return `${publicAppOrigin()}${DEFAULT_OG_IMAGE_PATH}`;
}

function toAbsoluteUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return `${publicAppOrigin()}${trimmed}`;
  return null;
}

/** Banner, then logo, then the TradeFlow default — never an empty image. */
export function resolveOgImageUrl(
  bannerUrl?: string | null,
  logoUrl?: string | null,
): string {
  return (
    toAbsoluteUrl(bannerUrl ?? "") ??
    toAbsoluteUrl(logoUrl ?? "") ??
    defaultOgImageUrl()
  );
}

export function shareMetadata(options: {
  title: string;
  description: string;
  url: string;
  imageUrl: string;
  imageAlt?: string;
}): Metadata {
  const { title, description, url, imageUrl, imageAlt } = options;
  const isDefault = imageUrl === defaultOgImageUrl();
  const image = isDefault
    ? { url: imageUrl, width: 1200, height: 630, alt: imageAlt ?? title }
    : { url: imageUrl, alt: imageAlt ?? title };

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: "TradeFlow",
      title,
      description,
      url,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}
