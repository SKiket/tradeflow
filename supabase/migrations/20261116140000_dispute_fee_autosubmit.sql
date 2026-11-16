-- Step 21b-fix: received/counter fee tracking + contested flag + auto-submit gate.

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS contested BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS received_fee_pence INTEGER,
  ADD COLUMN IF NOT EXISTS counter_fee_pence INTEGER,
  ADD COLUMN IF NOT EXISTS fee_source TEXT
    CHECK (
      fee_source IS NULL
      OR fee_source IN ('stripe_balance_transactions', 'constants')
    ),
  ADD COLUMN IF NOT EXISTS auto_submit_eligible BOOLEAN,
  ADD COLUMN IF NOT EXISTS auto_submit_skipped_reason TEXT;

COMMENT ON COLUMN public.disputes.contested IS
  'True once evidence was submitted (seller or auto). Drives counter-fee recovery on loss.';
COMMENT ON COLUMN public.disputes.received_fee_pence IS
  'UK dispute-received fee charged back on loss/accept (usually £20).';
COMMENT ON COLUMN public.disputes.counter_fee_pence IS
  'UK dispute-countered fee charged back only when contested and lost (usually £20).';
COMMENT ON COLUMN public.disputes.fee_source IS
  'stripe_balance_transactions when read from Stripe; constants when env/default used.';

-- Backfill contested from existing submitted evidence.
UPDATE public.disputes
SET contested = TRUE
WHERE contested = FALSE
  AND (
    evidence_status = 'submitted'
    OR evidence_submitted_at IS NOT NULL
    OR submitted_by IS NOT NULL
  );
