-- D2: acknowledge flag for banner dismiss; statuses superseded/expired/
-- failed_processing are stored in delivery_status (text, no enum).

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS delivery_acknowledged_at timestamptz;

COMMENT ON COLUMN public.messages.delivery_acknowledged_at IS
  'When the seller dismissed the delivery banner item (or replied on the thread). Null = still counts toward the dashboard banner.';

CREATE INDEX IF NOT EXISTS messages_delivery_unacked_idx
  ON public.messages (business_id, created_at DESC)
  WHERE delivery_status IN ('failed', 'expired', 'failed_processing')
    AND delivery_acknowledged_at IS NULL;
