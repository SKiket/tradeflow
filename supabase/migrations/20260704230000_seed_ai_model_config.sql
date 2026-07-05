-- Seed test task for AI gateway verification (Step 4)
INSERT INTO public.ai_model_config (
  task_key,
  provider,
  model,
  fallback_provider,
  fallback_model,
  max_tokens,
  is_active
)
VALUES (
  'test_ping',
  'gemini',
  'gemini-2.5-flash',
  'gemini',
  'gemini-2.5-flash',
  256,
  TRUE
)
ON CONFLICT (task_key) DO UPDATE SET
  provider = EXCLUDED.provider,
  model = EXCLUDED.model,
  fallback_provider = EXCLUDED.fallback_provider,
  fallback_model = EXCLUDED.fallback_model,
  max_tokens = EXCLUDED.max_tokens,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
