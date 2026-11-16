-- Step 22: product knowledge, shop FAQ, AI knowledge gaps, describe usage.

-- Product knowledge (nullable additive columns).
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS usage_instructions TEXT,
  ADD COLUMN IF NOT EXISTS ingredients TEXT,
  ADD COLUMN IF NOT EXISTS storage_and_care TEXT,
  ADD COLUMN IF NOT EXISTS size_and_fit TEXT,
  ADD COLUMN IF NOT EXISTS allergens_text TEXT,
  ADD COLUMN IF NOT EXISTS allergens_status TEXT NOT NULL DEFAULT 'not_provided',
  ADD COLUMN IF NOT EXISTS product_faqs JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_allergens_status_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_allergens_status_check
  CHECK (allergens_status IN ('not_provided', 'none_declared', 'listed'));

COMMENT ON COLUMN public.products.allergens_status IS
  'not_provided | none_declared | listed. allergens_text used when listed.';
COMMENT ON COLUMN public.products.product_faqs IS
  'JSON array of {question, answer}; max 10 items enforced in app.';

-- Shop-level FAQ + delivery (on businesses).
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS shop_faq JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS delivery_info TEXT;

COMMENT ON COLUMN public.businesses.shop_faq IS
  'JSON array of {question, answer}; max 20 items enforced in app.';
COMMENT ON COLUMN public.businesses.delivery_info IS
  'Seller-written delivery information; max 1000 chars enforced in app.';

-- AI knowledge gaps (no customer/order/message identity).
CREATE TABLE IF NOT EXISTS public.ai_knowledge_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products (id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  times_asked INTEGER NOT NULL DEFAULT 1 CHECK (times_asked >= 1),
  first_asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'dismissed')),
  resolved_to TEXT
    CHECK (resolved_to IS NULL OR resolved_to IN ('product_faq', 'shop_faq')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_knowledge_gaps_question_text_len CHECK (char_length(question_text) <= 300)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_gaps_open_hash_uidx
  ON public.ai_knowledge_gaps (business_id, question_hash)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS ai_knowledge_gaps_business_status_idx
  ON public.ai_knowledge_gaps (business_id, status, last_asked_at DESC);

COMMENT ON TABLE public.ai_knowledge_gaps IS
  'Scrubbed buyer questions the AI could not answer from seller text. No customer PII.';

ALTER TABLE public.ai_knowledge_gaps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_knowledge_gaps FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_knowledge_gaps FROM anon;
GRANT SELECT, UPDATE ON TABLE public.ai_knowledge_gaps TO authenticated;
GRANT ALL ON TABLE public.ai_knowledge_gaps TO service_role;

DROP POLICY IF EXISTS ai_knowledge_gaps_select_own ON public.ai_knowledge_gaps;
CREATE POLICY ai_knowledge_gaps_select_own
  ON public.ai_knowledge_gaps
  FOR SELECT
  TO authenticated
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS ai_knowledge_gaps_update_own ON public.ai_knowledge_gaps;
CREATE POLICY ai_knowledge_gaps_update_own
  ON public.ai_knowledge_gaps
  FOR UPDATE
  TO authenticated
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_user_id = auth.uid()
    )
  );

-- Daily product_describe suggestion counter.
CREATE TABLE IF NOT EXISTS public.ai_describe_usage (
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  usage_date DATE NOT NULL DEFAULT (CURRENT_DATE),
  suggestion_count INTEGER NOT NULL DEFAULT 0 CHECK (suggestion_count >= 0),
  PRIMARY KEY (business_id, usage_date)
);

ALTER TABLE public.ai_describe_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_describe_usage FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_describe_usage FROM anon, authenticated;
GRANT ALL ON TABLE public.ai_describe_usage TO service_role;

-- Seed product_describe AI task (Gemini for vision).
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
  'product_describe',
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
