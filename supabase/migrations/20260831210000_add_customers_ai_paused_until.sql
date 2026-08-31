-- Human takeover: when a seller replies from the inbox, AI auto-replies
-- pause until this timestamp. NULL means the AI pipeline is active.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS ai_paused_until TIMESTAMPTZ;

COMMENT ON COLUMN public.customers.ai_paused_until IS
  'When set in the future, inbound messages are stored but order_parse/support_reply do not run. Set to NOW()+24h on a seller dashboard reply; cleared by Resume AI.';
