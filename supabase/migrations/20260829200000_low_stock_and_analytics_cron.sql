-- Low-stock alert dedup + shared pg_cron HTTP trigger for /api/cron/*.
-- Business logic stays in TypeScript; this only adds the column and schedules.

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS low_stock_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.product_variants.low_stock_alerted_at IS
  'When the last low-stock WhatsApp alert was sent for this variant. Null when at/above threshold (or never alerted). Compare-and-swap guard against duplicate daily alerts.';

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

COMMENT ON FUNCTION public.invoke_app_cron(text) IS
  'pg_cron trigger: POST a /api/cron/* path with the vault cron_shared_secret. No business logic.';

DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron extension not available, skipping low-stock / analytics schedules';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'low-stock-alerts') THEN
    PERFORM cron.unschedule('low-stock-alerts');
  END IF;
  PERFORM cron.schedule(
    'low-stock-alerts',
    '0 8 * * *',
    $job$SELECT public.invoke_app_cron('/api/cron/low-stock-alerts')$job$
  );

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'analytics-aggregate') THEN
    PERFORM cron.unschedule('analytics-aggregate');
  END IF;
  PERFORM cron.schedule(
    'analytics-aggregate',
    '0 * * * *',
    $job$SELECT public.invoke_app_cron('/api/cron/analytics-aggregate')$job$
  );
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'cron.job not available, skipping low-stock / analytics schedules';
  WHEN undefined_function THEN
    RAISE NOTICE 'cron.schedule not available, skipping low-stock / analytics schedules';
  WHEN OTHERS THEN
    RAISE NOTICE 'low-stock / analytics schedule skipped: %', SQLERRM;
END
$cron$;
