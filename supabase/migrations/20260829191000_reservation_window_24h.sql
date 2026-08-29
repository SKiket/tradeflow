-- Align reserved_until docs with the 24h hold (Stripe Checkout max / Section 12).
COMMENT ON COLUMN public.orders.reserved_until IS
  'When the stock hold expires (NOW + 24h at confirmation, matching Checkout Session expires_at). Lazy-swept when past.';
