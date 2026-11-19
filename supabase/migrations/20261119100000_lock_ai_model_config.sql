-- SEC-1: Lock down ai_model_config (service-role only).
-- Matches SQL already applied in the editor: ENABLE RLS + REVOKE from anon/authenticated.
-- No policies — PostgREST clients must not read or mutate global AI model settings.

ALTER TABLE public.ai_model_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_model_config FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_model_config FROM anon, authenticated;

GRANT ALL ON TABLE public.ai_model_config TO service_role;
