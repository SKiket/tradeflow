-- Step 24i: assisted Inbox replies — usage counter + AI task seeds.
-- Additive only. Reuses ai_describe_usage table with a separate assist_count.

ALTER TABLE public.ai_describe_usage
  ADD COLUMN IF NOT EXISTS assist_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_describe_usage_assist_count_check'
  ) THEN
    ALTER TABLE public.ai_describe_usage
      ADD CONSTRAINT ai_describe_usage_assist_count_check
      CHECK (assist_count >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.ai_describe_usage.assist_count IS
  'Daily count of Inbox polish/draft assists (Step 24i). Separate from product_describe suggestion_count.';

INSERT INTO public.ai_model_config (
  task_key,
  provider,
  model,
  fallback_provider,
  fallback_model,
  max_tokens,
  is_active
)
VALUES
  (
    'reply_polish',
    'gemini',
    'gemini-2.5-flash',
    'gemini',
    'gemini-2.5-flash',
    1024,
    TRUE
  ),
  (
    'reply_draft',
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
