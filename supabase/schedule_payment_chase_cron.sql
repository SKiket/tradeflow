-- Exact pg_cron + pg_net SQL used to invoke payment-chase every 15 minutes.
-- Applied by migration 20260829190100_schedule_payment_chase_cron.sql.
-- Secrets live in vault (never committed). This file is the human-readable copy.
--
-- Prerequisites: pg_cron and pg_net enabled; vault secrets:
--   cron_shared_secret  = CRON_SHARED_SECRET env var
--   tradeflow_app_url   = https://tradeflow-tau-blush.vercel.app

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.invoke_payment_chase_cron()
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
  SELECT decrypted_secret INTO cron_secret
  FROM vault.decrypted_secrets
  WHERE name = 'cron_shared_secret'
  LIMIT 1;

  SELECT decrypted_secret INTO app_url
  FROM vault.decrypted_secrets
  WHERE name = 'tradeflow_app_url'
  LIMIT 1;

  IF cron_secret IS NULL OR app_url IS NULL THEN
    RAISE WARNING 'payment-chase cron skipped: vault secrets cron_shared_secret / tradeflow_app_url missing';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := rtrim(app_url, '/') || '/api/cron/payment-chase',
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
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'payment-chase') THEN
    PERFORM cron.unschedule('payment-chase');
  END IF;
END $$;

SELECT cron.schedule(
  'payment-chase',
  '*/15 * * * *',
  $job$SELECT public.invoke_payment_chase_cron()$job$
);
