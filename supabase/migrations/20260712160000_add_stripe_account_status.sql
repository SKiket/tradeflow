-- Stripe Connect: cache each connected account's capability status locally so
-- payout-readiness can be checked without a live Stripe API call every time.
-- These are kept in sync via the account.updated webhook (and a backfill script).

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.businesses.stripe_charges_enabled IS
  'Mirror of Stripe account.charges_enabled; synced via account.updated webhook.';
COMMENT ON COLUMN public.businesses.stripe_payouts_enabled IS
  'Mirror of Stripe account.payouts_enabled; synced via account.updated webhook.';
COMMENT ON COLUMN public.businesses.stripe_details_submitted IS
  'Whether the seller finished Stripe onboarding (account.details_submitted).';
