-- Step 21c: all-in pricing configuration + order fee audit columns.

CREATE TABLE IF NOT EXISTS public.pricing_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  monthly_fee_pence INTEGER NOT NULL CHECK (monthly_fee_pence >= 0),
  order_fee_bps INTEGER NOT NULL CHECK (order_fee_bps >= 0),
  order_fee_fixed_pence INTEGER NOT NULL CHECK (order_fee_fixed_pence >= 0),
  trial_days INTEGER NOT NULL CHECK (trial_days >= 0),
  charge_order_fee_during_trial BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pricing_config_effective_from_idx
  ON public.pricing_config (effective_from DESC);

COMMENT ON TABLE public.pricing_config IS
  'Platform pricing history. Active row = latest effective_from <= now(). Service role only.';
COMMENT ON COLUMN public.pricing_config.order_fee_bps IS
  'Basis points of order total taken as Connect application fee (450 = 4.5%).';
COMMENT ON COLUMN public.pricing_config.order_fee_fixed_pence IS
  'Fixed pence added to each TradeFlow-paid order fee (20 = 20p).';
COMMENT ON COLUMN public.pricing_config.charge_order_fee_during_trial IS
  'When true, order application fee applies during subscription trial; monthly fee still waived by Stripe trial.';

ALTER TABLE public.pricing_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.pricing_config FROM PUBLIC;
REVOKE ALL ON TABLE public.pricing_config FROM anon, authenticated;
GRANT ALL ON TABLE public.pricing_config TO service_role;

INSERT INTO public.pricing_config (
  effective_from,
  monthly_fee_pence,
  order_fee_bps,
  order_fee_fixed_pence,
  trial_days,
  charge_order_fee_during_trial
)
SELECT
  now(),
  1900,
  450,
  20,
  30,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM public.pricing_config);

-- Audit columns on orders (additive).
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS application_fee_pence INTEGER
    CHECK (application_fee_pence IS NULL OR application_fee_pence >= 0),
  ADD COLUMN IF NOT EXISTS pricing_config_id UUID
    REFERENCES public.pricing_config (id);

COMMENT ON COLUMN public.orders.application_fee_pence IS
  'Connect application fee taken at payment time. Null when unpaid or paid outside TradeFlow.';
COMMENT ON COLUMN public.orders.pricing_config_id IS
  'pricing_config row used to compute application_fee_pence.';
