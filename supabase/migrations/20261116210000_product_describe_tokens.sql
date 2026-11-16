-- Raise product_describe output budget (Gemini 2.5 thinking + JSON).
UPDATE public.ai_model_config
SET max_tokens = 2048
WHERE task_key = 'product_describe'
  AND (max_tokens IS NULL OR max_tokens < 2048);
