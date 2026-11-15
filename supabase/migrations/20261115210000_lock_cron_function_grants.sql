-- Step 19b: revoke EXECUTE on cron / service-only SECURITY DEFINER functions
-- from PUBLIC, anon, and authenticated. pg_cron runs as postgres (superuser)
-- so scheduled jobs keep working. App cron auth + fulfilment keep service_role.

-- HTTP cron dispatcher (pg_cron only)
REVOKE ALL ON FUNCTION public.invoke_app_cron(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_app_cron(text) FROM anon, authenticated;
-- postgres retains via superuser; optional explicit grant for clarity:
GRANT EXECUTE ON FUNCTION public.invoke_app_cron(text) TO postgres;

-- Legacy payment-chase wrapper (pg_cron only)
REVOKE ALL ON FUNCTION public.invoke_payment_chase_cron() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_payment_chase_cron() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_payment_chase_cron() TO postgres;

-- Vault secret compare — service_role only (used by authorizeCronRequest)
REVOKE ALL ON FUNCTION public.cron_secret_matches(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cron_secret_matches(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_secret_matches(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cron_secret_matches(text) TO postgres;

-- Paid-order fulfilment RPC — Stripe webhook uses service_role admin client
REVOKE ALL ON FUNCTION public.fulfil_paid_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfil_paid_order(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_paid_order(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfil_paid_order(uuid) TO postgres;

-- Trigger helper: already revoked from PUBLIC, but anon/authenticated may still
-- hold EXECUTE via prior default grants. Triggers run as table owner.
REVOKE ALL ON FUNCTION public.sync_product_photo_url_from_gallery() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_product_photo_url_from_gallery() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_product_photo_url_from_gallery() TO postgres;

COMMENT ON FUNCTION public.invoke_app_cron(text) IS
  'pg_cron trigger: POST a /api/cron/* path with vault cron_shared_secret. EXECUTE revoked from PUBLIC/anon/authenticated.';
