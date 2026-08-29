-- Human-readable copy of the low-stock (daily 08:00 UTC) and analytics
-- (hourly) pg_cron jobs. Applied by
-- 20260829200000_low_stock_and_analytics_cron.sql.
-- Secrets: vault cron_shared_secret + tradeflow_app_url (same as payment-chase).

CREATE OR REPLACE FUNCTION public.invoke_app_cron(p_path text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  request_id bigint;
  cron_secret text;
  app_url text;
BEGIN
  IF p_path IS NULL OR left(p_path, 1) <> '/' THEN
    RAISE WARNING 'invoke_app_cron skipped: path must start with /';
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO cron_secret
  FROM vault.decrypted_secrets
  WHERE name = 'cron_shared_secret'
  LIMIT 1;

  SELECT decrypted_secret INTO app_url
  FROM vault.decrypted_secrets
  WHERE name = 'tradeflow_app_url'
  LIMIT 1;

  IF cron_secret IS NULL OR app_url IS NULL THEN
    RAISE WARNING 'invoke_app_cron skipped: vault secrets cron_shared_secret / tradeflow_app_url missing';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := rtrim(app_url, '/') || p_path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body := '{}'::jsonb
  ) INTO request_id;

  RETURN request_id;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'low-stock-alerts') THEN
    PERFORM cron.unschedule('low-stock-alerts');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'analytics-aggregate') THEN
    PERFORM cron.unschedule('analytics-aggregate');
  END IF;
END $$;

SELECT cron.schedule(
  'low-stock-alerts',
  '0 8 * * *',
  $job$SELECT public.invoke_app_cron('/api/cron/low-stock-alerts')$job$
);

SELECT cron.schedule(
  'analytics-aggregate',
  '0 * * * *',
  $job$SELECT public.invoke_app_cron('/api/cron/analytics-aggregate')$job$
);
