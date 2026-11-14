-- Outbound delivery tracking: every send attempt (including Twilio
-- rejections with no SID) is persisted so failures are never silent.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivery_error_code text,
  ADD COLUMN IF NOT EXISTS delivery_error_text text,
  ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_audience text;

COMMENT ON COLUMN public.messages.delivery_status IS
  'Outbound only: sent | failed | simulated. Null for inbound.';
COMMENT ON COLUMN public.messages.delivery_error_code IS
  'Provider/error code when delivery_status=failed (e.g. 63038).';
COMMENT ON COLUMN public.messages.delivery_error_text IS
  'Short plain-language failure reason for Inbox / banner.';
COMMENT ON COLUMN public.messages.delivery_attempts IS
  'How many Twilio send attempts have been made for this outbound row.';
COMMENT ON COLUMN public.messages.next_retry_at IS
  'When the retry cron may re-attempt a failed outbound send. Null when not retrying.';
COMMENT ON COLUMN public.messages.delivery_audience IS
  'buyer | seller — used for dashboard failure banners.';

CREATE INDEX IF NOT EXISTS messages_delivery_retry_idx
  ON public.messages (next_retry_at)
  WHERE delivery_status = 'failed' AND next_retry_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_delivery_failed_recent_idx
  ON public.messages (business_id, created_at DESC)
  WHERE delivery_status = 'failed';

-- Retry cron: every 5 minutes → /api/cron/whatsapp-delivery-retry
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron extension not available, skipping whatsapp-delivery-retry schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-delivery-retry') THEN
    PERFORM cron.unschedule('whatsapp-delivery-retry');
  END IF;
  PERFORM cron.schedule(
    'whatsapp-delivery-retry',
    '*/5 * * * *',
    $job$SELECT public.invoke_app_cron('/api/cron/whatsapp-delivery-retry')$job$
  );
END;
$cron$;
