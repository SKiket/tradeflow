-- Existing PAID / refunded / dispatched test orders were often created by
-- verify scripts that set orders.status without a PAID row in
-- order_status_history. Analytics keys off that transition, so backfill it.
-- Production fulfil_paid_order already writes PAID history going forward.

INSERT INTO public.order_status_history (
  order_id,
  business_id,
  from_status,
  to_status,
  changed_at
)
SELECT
  o.id,
  o.business_id,
  'AWAITING_PAYMENT',
  'PAID',
  o.created_at
FROM public.orders o
WHERE o.deleted_at IS NULL
  AND o.status IN (
    'PAID',
    'DISPATCHED',
    'DELIVERED',
    'REFUND_PENDING',
    'PARTIALLY_REFUNDED',
    'REFUNDED'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.order_status_history h
    WHERE h.order_id = o.id
      AND h.to_status = 'PAID'
  );
