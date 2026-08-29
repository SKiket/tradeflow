-- Allow the Next.js cron route (service_role) to verify the same secret
-- pg_net sends from vault, so production works even before CRON_SHARED_SECRET
-- is added as a Vercel env var. Anon/authenticated cannot execute this.

CREATE OR REPLACE FUNCTION public.cron_secret_matches(p_secret text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault
AS $$
DECLARE
  expected text;
BEGIN
  IF p_secret IS NULL OR length(p_secret) = 0 THEN
    RETURN false;
  END IF;

  SELECT decrypted_secret INTO expected
  FROM vault.decrypted_secrets
  WHERE name = 'cron_shared_secret'
  LIMIT 1;

  IF expected IS NULL THEN
    RETURN false;
  END IF;

  RETURN expected = p_secret;
END;
$$;

COMMENT ON FUNCTION public.cron_secret_matches(text) IS
  'Compare a presented cron secret to vault.cron_shared_secret. Service-role only.';

REVOKE ALL ON FUNCTION public.cron_secret_matches(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cron_secret_matches(text) TO service_role;
