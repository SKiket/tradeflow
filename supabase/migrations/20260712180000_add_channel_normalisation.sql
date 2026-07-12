-- Channel normalisation (Spec Section 6.4).
--
-- Business resolution: Twilio's inbound WhatsApp webhook identifies the
-- receiving business by phone number (the `To` field, e.g. whatsapp:+1415...),
-- not by WABA id — and the WABA id isn't present in the webhook payload at all.
-- So we track the connected WhatsApp sender number to resolve the owning
-- business from an inbound message.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS whatsapp_phone_e164 TEXT;

COMMENT ON COLUMN public.businesses.whatsapp_phone_e164 IS
  'Connected WhatsApp sender number in E.164 (e.g. +14155238886). Matched against Twilio inbound "To" to resolve the owning business.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_whatsapp_phone_e164
  ON public.businesses (whatsapp_phone_e164)
  WHERE whatsapp_phone_e164 IS NOT NULL AND deleted_at IS NULL;

-- Media capture: store inbound media URLs (WhatsApp images etc.) as a
-- first-class array on the normalised message. Order parsing from media is
-- separate, later work — this only records that media arrived.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_urls TEXT[];

COMMENT ON COLUMN public.messages.media_urls IS
  'Inbound media URLs (e.g. Twilio MediaUrl0..N) captured during normalisation.';

-- Thread lookup: reused open thread per (business_id, customer_id).
CREATE INDEX IF NOT EXISTS idx_messages_thread_lookup
  ON public.messages (business_id, customer_id, created_at DESC);
