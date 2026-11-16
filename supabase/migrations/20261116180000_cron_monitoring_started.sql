-- Step 21e: monitoring start timestamp for never-ran expected cron jobs.

CREATE TABLE IF NOT EXISTS public.cron_monitoring_config (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  monitoring_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cron_monitoring_config IS
  'Singleton: when cron heartbeat monitoring began. Used to flag expected jobs that have never succeeded.';
COMMENT ON COLUMN public.cron_monitoring_config.monitoring_started_at IS
  'Set once at insert. Never-ran jobs degrade after 3× interval (daily: 26h) from this time.';

ALTER TABLE public.cron_monitoring_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cron_monitoring_config FROM PUBLIC;
REVOKE ALL ON TABLE public.cron_monitoring_config FROM anon, authenticated;
GRANT ALL ON TABLE public.cron_monitoring_config TO service_role;

INSERT INTO public.cron_monitoring_config (id, monitoring_started_at)
VALUES (1, now())
ON CONFLICT (id) DO NOTHING;
