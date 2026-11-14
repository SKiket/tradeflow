-- Buyer preferred language (ISO 639-1). Null until detected from a
-- substantive inbound message. Short replies (oui/ok/yes) never flip it.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS preferred_language text NULL;

COMMENT ON COLUMN public.customers.preferred_language IS
  'ISO 639-1 buyer language (e.g. en, fr). Updated only from substantive inbound messages, never from one-word replies like ok/yes/oui.';
