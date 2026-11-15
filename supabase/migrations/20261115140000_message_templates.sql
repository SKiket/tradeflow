-- Step 16: Meta/Twilio WhatsApp message templates (draft until WABA approved).
-- Platform-wide rows (business_id NULL) plus optional per-seller overrides.
-- RLS on with no tenant policies — service role only.

CREATE TABLE IF NOT EXISTS public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL,
  language text NOT NULL CHECK (language IN ('en', 'fr')),
  body text NOT NULL,
  variable_names text[] NOT NULL DEFAULT '{}',
  category text NOT NULL DEFAULT 'utility',
  twilio_content_sid text,
  meta_status text NOT NULL DEFAULT 'draft'
    CHECK (meta_status IN ('draft', 'submitted', 'approved', 'rejected')),
  business_id uuid REFERENCES public.businesses (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS message_templates_key_lang_biz_uidx
  ON public.message_templates (
    template_key,
    language,
    COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS message_templates_lookup_idx
  ON public.message_templates (template_key, language, meta_status);

COMMENT ON TABLE public.message_templates IS
  'WhatsApp utility templates. business_id NULL = platform-wide; non-null = per-seller WABA override.';
COMMENT ON COLUMN public.message_templates.twilio_content_sid IS
  'Twilio ContentSid (HX…) once created/approved; null while draft.';
COMMENT ON COLUMN public.message_templates.meta_status IS
  'draft | submitted | approved | rejected — only approved rows are sendable.';

CREATE TRIGGER set_message_templates_updated_at
  BEFORE UPDATE ON public.message_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

-- No policies for authenticated/anon → deny all tenant access.
-- service_role bypasses RLS.

REVOKE ALL ON TABLE public.message_templates FROM PUBLIC;
REVOKE ALL ON TABLE public.message_templates FROM anon;
REVOKE ALL ON TABLE public.message_templates FROM authenticated;
GRANT ALL ON TABLE public.message_templates TO service_role;

-- Record how each outbound WhatsApp was sent (free-form vs template).
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS send_mode text
    CHECK (send_mode IS NULL OR send_mode IN ('freeform', 'template')),
  ADD COLUMN IF NOT EXISTS template_key text;

COMMENT ON COLUMN public.messages.send_mode IS
  'Outbound WhatsApp path used: freeform | template. Null for inbound.';
COMMENT ON COLUMN public.messages.template_key IS
  'message_templates.template_key when send_mode=template (or intended key on failed outside-window attempts).';
