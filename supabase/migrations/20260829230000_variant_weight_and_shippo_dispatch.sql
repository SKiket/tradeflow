-- Parcel weight for Shippo rates, plus real label/tracking IDs from purchase.
-- Default 200g covers a typical mug/soap/small-goods SKU until the seller sets a real weight.

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS weight_grams INTEGER NOT NULL DEFAULT 200;

ALTER TABLE public.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_weight_grams_check;
ALTER TABLE public.product_variants
  ADD CONSTRAINT product_variants_weight_grams_check CHECK (weight_grams > 0);

COMMENT ON COLUMN public.product_variants.weight_grams IS
  'Parcel contribution in grams. Shippo shipment weight is sum(weight_grams × quantity). Default 200.';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS dispatch_label_url TEXT,
  ADD COLUMN IF NOT EXISTS shippo_shipment_id TEXT,
  ADD COLUMN IF NOT EXISTS shippo_transaction_id TEXT;

COMMENT ON COLUMN public.orders.dispatch_tracking_number IS
  'Carrier tracking number from the purchased Shippo label.';
COMMENT ON COLUMN public.orders.dispatch_carrier IS
  'Carrier name from the purchased Shippo rate.';
COMMENT ON COLUMN public.orders.dispatch_label_url IS
  'Shippo label PDF/PNG URL for the purchased transaction.';
COMMENT ON COLUMN public.orders.shippo_shipment_id IS
  'Shippo shipment object_id used to shop rates.';
COMMENT ON COLUMN public.orders.shippo_transaction_id IS
  'Shippo transaction object_id for the purchased label.';
