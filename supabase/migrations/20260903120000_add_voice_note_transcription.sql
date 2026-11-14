-- Voice-note transcription: mark inbound messages sourced from audio,
-- and seed the audio_transcribe AI gateway task.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS source_kind text NULL;

COMMENT ON COLUMN public.messages.source_kind IS
  'Nullable message origin marker. "voice_note" when normalised_text came from WhatsApp audio transcription. Null for typed/other messages.';

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
  'audio_transcribe',
  'gemini',
  'gemini-2.5-flash',
  'gemini',
  'gemini-2.5-flash',
  512,
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
