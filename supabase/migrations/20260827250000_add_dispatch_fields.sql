-- Dispatch metadata on orders (free-text, no carrier integration yet).
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS dispatch_tracking_number TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_carrier TEXT;

COMMENT ON COLUMN public.orders.dispatch_tracking_number IS
  'Seller-entered tracking reference, set when order is dispatched.';
COMMENT ON COLUMN public.orders.dispatch_carrier IS
  'Seller-entered carrier name, set when order is dispatched.';
