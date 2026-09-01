-- Per-seller storefront accent. NULL means "use TradeFlow amber" at render
-- time — no DB default, personalisation is additive.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS storefront_accent_color TEXT;

ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS storefront_accent_color_hex;

ALTER TABLE public.businesses
  ADD CONSTRAINT storefront_accent_color_hex
  CHECK (
    storefront_accent_color IS NULL
    OR storefront_accent_color ~ '^#[0-9A-Fa-f]{6}$'
  );

COMMENT ON COLUMN public.businesses.storefront_accent_color IS
  'Nullable #RRGGBB accent for the public storefront/checkout/tracking CTAs. NULL uses TradeFlow amber (#F5C518). Never applied to dashboard chrome.';
