-- Operator-run: schedule shop purge cron (do NOT put secrets in the repo).
-- Prerequisites: pg_cron + pg_net, vault secrets cron_shared_secret + tradeflow_app_url,
-- and public.invoke_app_cron(path text) already installed (see payment-chase migration).
--
-- Run manually in the Supabase SQL editor after deploying /api/cron/shop-purge.

DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron extension not available, skipping shop-purge schedule';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'invoke_app_cron'
  ) THEN
    RAISE NOTICE 'invoke_app_cron missing — apply payment-chase cron migration first';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shop-purge') THEN
    PERFORM cron.unschedule('shop-purge');
  END IF;

  -- Daily 03:15 UTC — after grace period, permanently erase closed shops.
  PERFORM cron.schedule(
    'shop-purge',
    '15 3 * * *',
    $job$SELECT public.invoke_app_cron('/api/cron/shop-purge')$job$
  );
END;
$cron$;
