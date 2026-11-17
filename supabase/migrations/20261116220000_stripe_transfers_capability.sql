-- Step 23: cache Connect transfers capability + requirements for payment gate.
-- Additive only; nullable / defaulted columns.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS stripe_transfers_capability_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_requirements_currently_due JSONB NULL;

COMMENT ON COLUMN public.businesses.stripe_transfers_capability_active IS
  'True when Stripe account.capabilities.transfers.status = active; synced via account.updated.';
COMMENT ON COLUMN public.businesses.stripe_requirements_currently_due IS
  'Mirror of Stripe account.requirements.currently_due (string array JSON); synced via account.updated.';
