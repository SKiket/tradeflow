-- Service-window tracking (WhatsApp 24-hour customer care window).
--
-- Records when a customer last messaged the business, so outbound send logic
-- (order confirmations now, broadcasts later) can cheaply check whether a
-- free-form message is allowed without re-querying the messages table.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ;

COMMENT ON COLUMN public.customers.last_customer_message_at IS
  'Timestamp of the customer''s most recent INBOUND message. Drives the 24h service-window check (isInServiceWindow).';
