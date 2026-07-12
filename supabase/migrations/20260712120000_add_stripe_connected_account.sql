-- Stripe Connect: store each business's Express connected account id.
-- Onboarding now routes sellers through Stripe's hosted flow instead of
-- capturing raw bank details, so payout_* columns are left in place only for
-- historical rows and are no longer written by the onboarding wizard.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS stripe_connected_account_id TEXT;

COMMENT ON COLUMN public.businesses.stripe_connected_account_id IS
  'Stripe Express connected account id (acct_...). Populated during onboarding.';
