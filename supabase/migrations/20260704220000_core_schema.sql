-- TradeFlow core schema (Section 19)
-- Multi-tenant isolation via business_id + RLS from day one.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.businesses (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  owner_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  bio TEXT,
  logo_url TEXT,
  banner_url TEXT,
  dispatch_address_line1 TEXT,
  dispatch_city TEXT,
  dispatch_postcode TEXT,
  dispatch_days TEXT[],
  ai_tone TEXT NOT NULL DEFAULT 'friendly',
  returns_policy_text TEXT,
  whatsapp_waba_id TEXT,
  payout_account_holder_name TEXT,
  payout_sort_code TEXT,
  payout_account_number TEXT,
  payout_dob DATE,
  payout_address_line1 TEXT,
  payout_city TEXT,
  payout_postcode TEXT,
  plan TEXT NOT NULL DEFAULT 'starter',
  plan_status TEXT NOT NULL DEFAULT 'active',
  feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  price_pence INTEGER NOT NULL,
  photo_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE public.product_variants (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES public.products (id) ON DELETE RESTRICT,
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  label TEXT,
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  track_inventory BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE public.customers (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  phone_e164 TEXT NOT NULL,
  name TEXT,
  channel_identifiers JSONB NOT NULL DEFAULT '{}'::jsonb,
  addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT[],
  notes TEXT,
  lifetime_value_pence INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  last_order_at TIMESTAMPTZ,
  broadcast_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  review_score_avg NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (business_id, phone_e164)
);

CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  ai_parse_confidence NUMERIC,
  payment_method TEXT,
  total_pence INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  order_ref TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE public.order_items (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  product_variant_id UUID NOT NULL REFERENCES public.product_variants (id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  unit_price_pence INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.order_status_history (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  raw_payload JSONB,
  normalised_text TEXT,
  thread_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE public.broadcasts (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  segment JSONB NOT NULL DEFAULT '{}'::jsonb,
  message TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE public.analytics_cache (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  period TEXT NOT NULL,
  revenue_pence INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (business_id, period)
);

CREATE TABLE public.ai_model_config (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  task_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  fallback_provider TEXT,
  fallback_model TEXT,
  max_tokens INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX idx_products_business_id ON public.products (business_id);
CREATE INDEX idx_product_variants_business_id ON public.product_variants (business_id);
CREATE INDEX idx_product_variants_product_id ON public.product_variants (product_id);
CREATE INDEX idx_customers_business_id ON public.customers (business_id);
CREATE INDEX idx_orders_business_id ON public.orders (business_id);
CREATE INDEX idx_orders_customer_id ON public.orders (customer_id);
CREATE INDEX idx_order_items_business_id ON public.order_items (business_id);
CREATE INDEX idx_order_items_order_id ON public.order_items (order_id);
CREATE INDEX idx_order_status_history_business_id ON public.order_status_history (business_id);
CREATE INDEX idx_order_status_history_order_id ON public.order_status_history (order_id);
CREATE INDEX idx_messages_business_id ON public.messages (business_id);
CREATE INDEX idx_broadcasts_business_id ON public.broadcasts (business_id);
CREATE INDEX idx_analytics_cache_business_id ON public.analytics_cache (business_id);
CREATE INDEX idx_businesses_owner_user_id ON public.businesses (owner_user_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER set_businesses_updated_at
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_product_variants_updated_at
  BEFORE UPDATE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_ai_model_config_updated_at
  BEFORE UPDATE ON public.ai_model_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_cache ENABLE ROW LEVEL SECURITY;

-- businesses (scoped by owner_user_id)
CREATE POLICY businesses_select ON public.businesses
  FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid() AND deleted_at IS NULL);

CREATE POLICY businesses_insert ON public.businesses
  FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY businesses_update ON public.businesses
  FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY businesses_delete ON public.businesses
  FOR DELETE TO authenticated
  USING (owner_user_id = auth.uid());

-- Tenant-scoped tables (scoped via business_id)
CREATE POLICY products_select ON public.products
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND deleted_at IS NULL
  );

CREATE POLICY products_insert ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY products_update ON public.products
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY products_delete ON public.products
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY product_variants_select ON public.product_variants
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND deleted_at IS NULL
  );

CREATE POLICY product_variants_insert ON public.product_variants
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY product_variants_update ON public.product_variants
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY product_variants_delete ON public.product_variants
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY customers_select ON public.customers
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND deleted_at IS NULL
  );

CREATE POLICY customers_insert ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY customers_update ON public.customers
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY customers_delete ON public.customers
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY orders_select ON public.orders
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND deleted_at IS NULL
  );

CREATE POLICY orders_insert ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY orders_update ON public.orders
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY orders_delete ON public.orders
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY order_items_select ON public.order_items
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY order_items_insert ON public.order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY order_items_update ON public.order_items
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY order_items_delete ON public.order_items
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY order_status_history_select ON public.order_status_history
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY order_status_history_insert ON public.order_status_history
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY messages_select ON public.messages
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND deleted_at IS NULL
  );

CREATE POLICY messages_insert ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY messages_update ON public.messages
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY messages_delete ON public.messages
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY broadcasts_select ON public.broadcasts
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND deleted_at IS NULL
  );

CREATE POLICY broadcasts_insert ON public.broadcasts
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY broadcasts_update ON public.broadcasts
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY broadcasts_delete ON public.broadcasts
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY analytics_cache_select ON public.analytics_cache
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND deleted_at IS NULL
  );

CREATE POLICY analytics_cache_insert ON public.analytics_cache
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY analytics_cache_update ON public.analytics_cache
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY analytics_cache_delete ON public.analytics_cache
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

-- ai_model_config: global, no RLS

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON public.ai_model_config TO anon;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
