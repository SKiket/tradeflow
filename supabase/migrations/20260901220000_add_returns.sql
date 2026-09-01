-- Buyer-initiated returns. Statuses are application-enforced (orders.status is TEXT).
-- return_reason is captured on every request for later reporting.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS return_reason TEXT,
  ADD COLUMN IF NOT EXISTS return_reason_detail TEXT,
  ADD COLUMN IF NOT EXISTS return_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_notes TEXT;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_return_reason_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_return_reason_check
  CHECK (
    return_reason IS NULL
    OR return_reason IN (
      'wrong_size',
      'damaged_faulty',
      'changed_mind',
      'not_as_described',
      'arrived_late',
      'other'
    )
  );

COMMENT ON COLUMN public.orders.return_reason IS
  'Structured return reason; set when a return is requested and kept for reporting.';
COMMENT ON COLUMN public.orders.return_reason_detail IS
  'Buyer''s own words; always stored for ''other'', optional extra detail otherwise.';
COMMENT ON COLUMN public.orders.return_requested_at IS
  'When the buyer requested the return (WhatsApp or tracking page).';
COMMENT ON COLUMN public.orders.return_decided_at IS
  'When the seller approved or declined the return.';
COMMENT ON COLUMN public.orders.return_notes IS
  'Seller notes from approve/decline; optional.';
