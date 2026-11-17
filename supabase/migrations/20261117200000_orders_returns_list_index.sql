-- Speed seller Returns list (business + status + return_requested_at ordering).

CREATE INDEX IF NOT EXISTS idx_orders_business_status_return_requested
  ON public.orders (business_id, status, return_requested_at)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.idx_orders_business_status_return_requested IS
  'Supports Returns tabs: filter by business/status and sort by return_requested_at.';
