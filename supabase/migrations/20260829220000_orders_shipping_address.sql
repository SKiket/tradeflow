-- Delivery address captured from Stripe Checkout shipping_address_collection
-- on checkout.session.completed / async_payment_succeeded. Shape:
-- { line1, line2, city, postcode, country } (postcode maps from Stripe postal_code).

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_address JSONB;

COMMENT ON COLUMN public.orders.shipping_address IS
  'Buyer delivery address from Stripe Checkout shipping_details. Null until a paid (or pending-async) session supplies one.';
