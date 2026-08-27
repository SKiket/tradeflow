-- Step 10: time-boxed stock holds and Stripe Checkout tracking on orders.
--
-- reserved_until lives on orders (not order_items) because the 30-minute
-- hold applies to the whole draft; reserved_quantity increments happen on
-- product_variants at confirmation time.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT;

COMMENT ON COLUMN public.orders.reserved_until IS
  'When the stock hold expires (NOW + 30m at confirmation). Lazy-swept when past.';
COMMENT ON COLUMN public.orders.stripe_checkout_session_id IS
  'Stripe Checkout Session id (cs_...) created when buyer confirms draft.';

CREATE INDEX IF NOT EXISTS idx_orders_awaiting_payment_sweep
  ON public.orders (business_id, reserved_until)
  WHERE status = 'AWAITING_PAYMENT'
    AND reserved_until IS NOT NULL
    AND deleted_at IS NULL;
