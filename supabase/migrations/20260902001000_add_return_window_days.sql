-- Seller-configurable cooling-off window (days). Default 14; values below 14
-- are allowed — the dashboard warns, the system does not block.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS return_window_days INTEGER NOT NULL DEFAULT 14;

COMMENT ON COLUMN public.businesses.return_window_days IS
  'Structured return window in days used for auto-approving changed_mind cooling-off returns. Dashboard warns below 14 but does not block.';

-- Distinguishes statutory auto-approval from a seller dashboard decision.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS return_auto_approved BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.orders.return_auto_approved IS
  'True when the return was auto-approved under changed_mind within return_window_days; false for seller-approved returns.';
