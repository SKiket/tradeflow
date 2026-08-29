-- Seller-wide default for new product variants. Existing variants keep their
-- own low_stock_threshold; this is only the starting value in the product form.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS default_low_stock_threshold INTEGER NOT NULL DEFAULT 5;

COMMENT ON COLUMN public.businesses.default_low_stock_threshold IS
  'Default low_stock_threshold applied when a seller adds a new product variant.';
