import type { CSSProperties } from "react";

/** Copalla amber — TradeFlow's default storefront CTA when a seller has not set a colour. */
export const TRADEFLOW_STOREFRONT_ACCENT = "#F5C518";
export const TRADEFLOW_ACCENT_TEXT_ON_LIGHT = "#1E3B5D";
export const TRADEFLOW_ACCENT_TEXT_ON_DARK = "#FFFFFF";

const HEX_RE = /^#([0-9A-Fa-f]{6})$/;

export function parseAccentHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = HEX_RE.exec(value.trim());
  if (!match) return null;
  return `#${match[1].toUpperCase()}`;
}

export function resolveStorefrontAccent(value: unknown): string {
  return parseAccentHex(value) ?? TRADEFLOW_STOREFRONT_ACCENT;
}

export function accentForeground(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return TRADEFLOW_ACCENT_TEXT_ON_LIGHT;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55
    ? TRADEFLOW_ACCENT_TEXT_ON_LIGHT
    : TRADEFLOW_ACCENT_TEXT_ON_DARK;
}

export type TenantAccentStyle = CSSProperties & {
  "--tenant-accent": string;
  "--tenant-accent-text": string;
};

export function tenantAccentStyle(value: unknown): TenantAccentStyle {
  const accent = resolveStorefrontAccent(value);
  return {
    "--tenant-accent": accent,
    "--tenant-accent-text": accentForeground(accent),
  };
}

export const STOREFRONT_ACCENT_PRESETS = [
  { id: "default", label: "TradeFlow amber", value: null as string | null },
  { id: "teal", label: "Teal", value: "#177EA1" },
  { id: "coral", label: "Coral", value: "#E07A5F" },
  { id: "navy", label: "Navy", value: "#1E3B5D" },
  { id: "mint", label: "Mint", value: "#3DD6C8" },
] as const;
