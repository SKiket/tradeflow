-- Step 13: refund tracking on orders + processed-refund ledger for webhook idempotency.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS refunded_amount_pence INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

COMMENT ON COLUMN public.orders.refunded_amount_pence IS
  'Cumulative amount refunded in pence; updated by refund.updated webhook on success.';
COMMENT ON COLUMN public.orders.stripe_payment_intent_id IS
  'Stripe PaymentIntent id (pi_...) captured at fulfilment from the Checkout Session.';

CREATE INDEX IF NOT EXISTS idx_orders_stripe_payment_intent_id
  ON public.orders (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- Ledger of Stripe refunds — idempotency guard for refund.updated redelivery.
CREATE TABLE IF NOT EXISTS public.order_refunds (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  stripe_refund_id TEXT NOT NULL UNIQUE,
  amount_pence INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  prior_order_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id ON public.order_refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_order_refunds_business_id ON public.order_refunds (business_id);

ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_refunds_select ON public.order_refunds
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY order_refunds_insert ON public.order_refunds
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY order_refunds_update ON public.order_refunds
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );
