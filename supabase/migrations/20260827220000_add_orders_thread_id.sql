-- Draft orders from inbound WhatsApp order_parse need a thread link so
-- follow-up corrections ("actually make it size 11") update the same
-- PENDING_CONFIRMATION draft instead of creating a duplicate.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS thread_id UUID;

COMMENT ON COLUMN public.orders.thread_id IS
  'Conversation thread this draft/order belongs to (messages.thread_id). Used to find/replace PENDING_CONFIRMATION drafts.';

CREATE INDEX IF NOT EXISTS idx_orders_thread_id
  ON public.orders (business_id, thread_id)
  WHERE thread_id IS NOT NULL AND deleted_at IS NULL;

-- At most one open confirmation draft per thread.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_pending_confirmation_per_thread
  ON public.orders (business_id, thread_id)
  WHERE status = 'PENDING_CONFIRMATION'
    AND thread_id IS NOT NULL
    AND deleted_at IS NULL;
