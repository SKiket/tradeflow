-- Step 23c: raise pg_net HTTP timeout for cron triggers (default 5s was too low).
-- Additive: CREATE OR REPLACE only; grants unchanged (still revoked from PUBLIC/anon/authenticated).

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
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

COMMENT ON FUNCTION public.invoke_app_cron(text) IS
  'pg_cron trigger: POST a /api/cron/* path with the vault cron_shared_secret. timeout_milliseconds=30000. No business logic.';

-- Re-assert grants (replace can reset ACLs depending on PG version).
REVOKE ALL ON FUNCTION public.invoke_app_cron(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_app_cron(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_app_cron(text) TO postgres;
GRANT EXECUTE ON FUNCTION public.invoke_app_cron(text) TO service_role;
