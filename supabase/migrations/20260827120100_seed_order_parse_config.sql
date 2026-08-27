-- Seed order_parse task for catalog-grounded inbound message parsing.
-- Uses more max_tokens than test_ping to allow multi-item order JSON.
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
  'order_parse',
  'gemini',
  'gemini-2.5-flash',
  'gemini',
  'gemini-2.5-flash',
  2048,
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
