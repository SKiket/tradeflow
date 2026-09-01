-- Platform billing: TradeFlow charges the seller (Stripe Customer +
-- Subscription on the PLATFORM account). This is separate from
-- stripe_connected_account_id, which is the seller's Connect account
-- for receiving their own buyers' payments.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_status TEXT,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS businesses_stripe_subscription_status_check;

ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_stripe_subscription_status_check
  CHECK (
    stripe_subscription_status IS NULL
    OR stripe_subscription_status IN (
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired'
    )
  );

COMMENT ON COLUMN public.businesses.stripe_customer_id IS
  'Stripe Customer id (cus_...) on the platform account. Money FROM the seller for TradeFlow billing. Distinct from stripe_connected_account_id.';
COMMENT ON COLUMN public.businesses.stripe_subscription_id IS
  'Stripe Subscription id (sub_...) for the £10/month platform plan.';
COMMENT ON COLUMN public.businesses.stripe_subscription_status IS
  'Synced from Stripe subscription webhooks. Source of truth — do not infer.';
COMMENT ON COLUMN public.businesses.trial_ends_at IS
  'Stripe subscription.trial_end. Both the £10/month and 1% application fee are waived while status is trialing.';
