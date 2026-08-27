-- Store the structured AI order-parse result on each inbound message so
-- parsing is inspectable without UI. Nullable: parse may fail or be skipped.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS ai_parse_result JSONB;

COMMENT ON COLUMN public.messages.ai_parse_result IS
  'Structured order_parse gateway result (intent, items, match confidence, clarification). Null if parse has not run or failed.';
