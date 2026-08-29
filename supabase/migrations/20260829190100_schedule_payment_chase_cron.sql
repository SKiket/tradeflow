-- Schedule payment-chase: pg_cron every 15 minutes → pg_net POST to the
-- Next.js route. Business logic stays in TypeScript; this SQL only triggers
-- it on time (same pattern as FamilyConnexion).
--
-- Secrets are read from vault so this migration never embeds CRON_SHARED_SECRET.
-- Insert them once (Dashboard SQL editor or `supabase sql`):
--
--   select vault.create_secret(
--     'REPLACE_WITH_CRON_SHARED_SECRET',
--     'cron_shared_secret',
--     'Shared secret for TradeFlow /api/cron/* routes'
--   );
--   select vault.create_secret(
--     'https://tradeflow-tau-blush.vercel.app',
--     'tradeflow_app_url',
--     'Public app URL that pg_cron should POST to'
--   );

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron extension not created: %', SQLERRM;
END $$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_net extension not created: %', SQLERRM;
END $$;

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

COMMENT ON FUNCTION public.invoke_payment_chase_cron() IS
  'pg_cron trigger: POST /api/cron/payment-chase with the vault cron_shared_secret. No business logic.';

DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron extension not available, skipping payment-chase schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'payment-chase') THEN
    PERFORM cron.unschedule('payment-chase');
  END IF;

  PERFORM cron.schedule(
    'payment-chase',
    '*/15 * * * *',
    $job$SELECT public.invoke_payment_chase_cron()$job$
  );
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'cron.job not available, skipping payment-chase schedule';
  WHEN undefined_function THEN
    RAISE NOTICE 'cron.schedule not available, skipping payment-chase schedule';
  WHEN OTHERS THEN
    RAISE NOTICE 'payment-chase schedule skipped: %', SQLERRM;
END
$cron$;
