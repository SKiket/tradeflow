-- Step 23b: payment-chase skip / retry outcomes + cron run summaries.
-- Additive only; existing rows stay valid (null outcomes, zero attempts).

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_reminder_12h_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_reminder_23h_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_reminder_12h_outcome TEXT NULL,
  ADD COLUMN IF NOT EXISTS payment_reminder_23h_outcome TEXT NULL,
  ADD COLUMN IF NOT EXISTS payment_reminder_seller_alerted_at TIMESTAMPTZ NULL;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_payment_reminder_12h_outcome_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_reminder_12h_outcome_check
  CHECK (
    payment_reminder_12h_outcome IS NULL
    OR payment_reminder_12h_outcome IN ('sent', 'skipped_no_channel', 'failed')
  );

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_payment_reminder_23h_outcome_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_reminder_23h_outcome_check
  CHECK (
    payment_reminder_23h_outcome IS NULL
    OR payment_reminder_23h_outcome IN ('sent', 'skipped_no_channel', 'failed')
  );

COMMENT ON COLUMN public.orders.payment_reminder_12h_outcome IS
  'Terminal 12h reminder outcome: sent | skipped_no_channel | failed. Null until resolved.';
COMMENT ON COLUMN public.orders.payment_reminder_23h_outcome IS
  'Terminal 23h reminder outcome: sent | skipped_no_channel | failed. Null until resolved.';
COMMENT ON COLUMN public.orders.payment_reminder_12h_attempts IS
  'Send attempts for the 12h unpaid reminder (max 3 before permanent failed).';
COMMENT ON COLUMN public.orders.payment_reminder_23h_attempts IS
  'Send attempts for the 23h unpaid reminder (max 3 before permanent failed).';
COMMENT ON COLUMN public.orders.payment_reminder_seller_alerted_at IS
  'When the seller was alerted once about a permanently failed payment reminder.';

ALTER TABLE public.cron_heartbeats
  ADD COLUMN IF NOT EXISTS last_run_summary TEXT NULL;

COMMENT ON COLUMN public.cron_heartbeats.last_run_summary IS
  'Short safe per-run counts/summary (e.g. sent/skipped/failed). No PII.';
