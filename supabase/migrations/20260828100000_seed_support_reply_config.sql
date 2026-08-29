-- Seed support_reply task for buyer questions grounded in configured business fields.
-- Uses more max_tokens than reply_classify so a short WhatsApp reply fits.
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
  'support_reply',
  'gemini',
  'gemini-2.5-flash',
  'gemini',
  'gemini-2.5-flash',
  1024,
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
