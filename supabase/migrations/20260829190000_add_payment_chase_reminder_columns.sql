-- Payment-chase idempotency columns (spec Section 12).
-- Cron uses these so overlapping 15-minute runs cannot double-send reminders.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_reminder_12h_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_reminder_23h_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.payment_reminder_12h_sent_at IS
  'When the 12h unpaid-order WhatsApp reminder was sent. Null until sent; compare-and-swap guard against duplicate cron sends.';

COMMENT ON COLUMN public.orders.payment_reminder_23h_sent_at IS
  'When the 23h unpaid-order WhatsApp reminder was sent. Null until sent; compare-and-swap guard against duplicate cron sends.';

CREATE INDEX IF NOT EXISTS idx_orders_payment_chase
  ON public.orders (status)
  WHERE status = 'AWAITING_PAYMENT'
    AND deleted_at IS NULL;
