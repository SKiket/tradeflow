-- Operator-run: schedule dispute evidence reminders + auto-submit cron.
-- Do NOT put secrets in the repo.
-- Prerequisites: pg_cron + pg_net, vault secrets cron_shared_secret + tradeflow_app_url,
-- and public.invoke_app_cron(path text) already installed.
--
-- Run manually in the Supabase SQL editor after deploying /api/cron/dispute-reminders.

DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron extension not available, skipping dispute-reminders schedule';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'invoke_app_cron'
  ) THEN
    RAISE NOTICE 'invoke_app_cron missing — apply cron migration first';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispute-reminders') THEN
    PERFORM cron.unschedule('dispute-reminders');
  END IF;

  -- Every hour — reminders at 5d/2d/1d and auto-submit within 24h of deadline.
  PERFORM cron.schedule(
    'dispute-reminders',
    '20 * * * *',
    $job$SELECT public.invoke_app_cron('/api/cron/dispute-reminders')$job$
  );
END;
$cron$;
