-- D3: queue inbound messages that got no buyer-facing reply so we can
-- replay them after rate limits / transient failures clear.

CREATE TABLE IF NOT EXISTS public.pending_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  thread_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'processing',
      'succeeded',
      'superseded',
      'expired',
      'failed'
    )),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  next_attempt_at timestamptz,
  last_error text,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inbound_message_id)
);

CREATE INDEX IF NOT EXISTS pending_replays_due_idx
  ON public.pending_replays (next_attempt_at)
  WHERE status = 'pending' AND next_attempt_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS pending_replays_business_pending_idx
  ON public.pending_replays (business_id, created_at DESC)
  WHERE status = 'pending';

COMMENT ON TABLE public.pending_replays IS
  'Inbound messages that produced no delivered buyer reply; replayed by cron.';

-- Every 15 minutes → /api/cron/pending-replay
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available, skipping pending-replay schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pending-replay') THEN
    PERFORM cron.unschedule('pending-replay');
  END IF;
  PERFORM cron.schedule(
    'pending-replay',
    '*/15 * * * *',
    $job$SELECT public.invoke_app_cron('/api/cron/pending-replay')$job$
  );
END;
$cron$;
