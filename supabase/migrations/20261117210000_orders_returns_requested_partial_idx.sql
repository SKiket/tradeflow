-- Tighten needs_decision Returns tab: count + sort only RETURN_REQUESTED rows.
CREATE INDEX IF NOT EXISTS idx_orders_business_return_requested_needs
  ON public.orders (business_id, return_requested_at)
  WHERE deleted_at IS NULL AND status = 'RETURN_REQUESTED';

COMMENT ON INDEX public.idx_orders_business_return_requested_needs IS
  'Partial index for Returns needs_decision tab (count + oldest-first page).';
