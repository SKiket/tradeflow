-- Step 21d: cron heartbeats for silent-failure detection.
-- Service role only; RLS on with no tenant policies.

CREATE TABLE IF NOT EXISTS public.cron_heartbeats (
  job_name TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_status TEXT NOT NULL DEFAULT 'never'
    CHECK (
      last_status IN ('never', 'success', 'failure', 'auth_failure')
    ),
  last_error_summary TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cron_heartbeats IS
  'Operator-only cron job health. No PII/secrets. Written by cron routes via service role.';
COMMENT ON COLUMN public.cron_heartbeats.last_error_summary IS
  'Short safe reason only — never secrets, phones, message bodies, or request payloads.';

ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cron_heartbeats FROM PUBLIC;
REVOKE ALL ON TABLE public.cron_heartbeats FROM anon, authenticated;
GRANT ALL ON TABLE public.cron_heartbeats TO service_role;

-- Known jobs (bootstrap rows; monitoring starts after first real start).
INSERT INTO public.cron_heartbeats (job_name, last_status)
VALUES
  ('payment-chase', 'never'),
  ('whatsapp-delivery-retry', 'never'),
  ('pending-replay', 'never'),
  ('dispute-reminders', 'never'),
  ('shop-purge', 'never'),
  ('low-stock-alerts', 'never'),
  ('analytics-aggregate', 'never')
ON CONFLICT (job_name) DO NOTHING;
