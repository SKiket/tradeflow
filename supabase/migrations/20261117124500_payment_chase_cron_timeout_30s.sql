-- Step 23c: payment-chase uses invoke_payment_chase_cron (not invoke_app_cron).
-- Raise pg_net timeout to 30s so cold starts are recorded as 200, not timed_out.
-- Additive CREATE OR REPLACE; re-assert grants.

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
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

COMMENT ON FUNCTION public.invoke_payment_chase_cron() IS
  'pg_cron trigger for /api/cron/payment-chase. timeout_milliseconds=30000.';

REVOKE ALL ON FUNCTION public.invoke_payment_chase_cron() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_payment_chase_cron() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_payment_chase_cron() TO postgres;
GRANT EXECUTE ON FUNCTION public.invoke_payment_chase_cron() TO service_role;
