-- Step 20: Shippo tracking webhook columns on orders.
-- No new SECURITY DEFINER functions in this migration.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tracking_status text,
  ADD COLUMN IF NOT EXISTS tracking_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

COMMENT ON COLUMN public.orders.tracking_status IS
  'Latest Shippo tracking_status.status (PRE_TRANSIT, TRANSIT, DELIVERED, RETURNED, FAILURE, UNKNOWN).';
COMMENT ON COLUMN public.orders.tracking_updated_at IS
  'When tracking_status was last updated from a Shippo track_updated webhook.';
COMMENT ON COLUMN public.orders.delivered_at IS
  'When the order became DELIVERED (manual mark or Shippo DELIVERED event). Cooling-off window starts here.';

-- Backfill delivered_at from the most recent DELIVERED status history row.
UPDATE public.orders o
SET delivered_at = h.changed_at
FROM (
  SELECT DISTINCT ON (order_id)
    order_id,
    changed_at
  FROM public.order_status_history
  WHERE to_status = 'DELIVERED'
  ORDER BY order_id, changed_at DESC
) h
WHERE o.id = h.order_id
  AND o.delivered_at IS NULL
  AND o.status IN (
    'DELIVERED',
    'RETURN_REQUESTED',
    'RETURN_APPROVED',
    'RETURN_DECLINED',
    'RETURNED',
    'REFUND_PENDING',
    'REFUNDED',
    'PARTIALLY_REFUNDED'
  );
