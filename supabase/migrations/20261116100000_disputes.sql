-- Step 21: Stripe disputes (destination charges), evidence pack, liability recovery.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS dispute_status TEXT;

COMMENT ON COLUMN public.orders.dispute_status IS
  'Denormalised Stripe dispute status for UI (null when no open/closed dispute).';

CREATE TABLE IF NOT EXISTS public.disputes (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  order_id UUID REFERENCES public.orders (id) ON DELETE RESTRICT,
  stripe_dispute_id TEXT NOT NULL UNIQUE,
  stripe_charge_id TEXT NOT NULL,
  amount_pence INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'gbp',
  reason TEXT,
  status TEXT NOT NULL,
  evidence_due_by TIMESTAMPTZ,
  evidence_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (evidence_status IN ('draft', 'ready', 'submitted', 'not_needed')),
  evidence_submitted_at TIMESTAMPTZ,
  submitted_by TEXT CHECK (submitted_by IS NULL OR submitted_by IN ('seller', 'auto')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('won', 'lost')),
  stripe_fee_pence INTEGER,
  funds_withdrawn_at TIMESTAMPTZ,
  funds_reinstated_at TIMESTAMPTZ,
  recovered_pence INTEGER NOT NULL DEFAULT 0,
  unrecovered_pence INTEGER NOT NULL DEFAULT 0,
  seller_notes TEXT,
  stripe_transfer_id TEXT,
  stripe_transfer_reversal_id TEXT,
  recovery_attempted_at TIMESTAMPTZ,
  opened_notified_at TIMESTAMPTZ,
  closed_notified_at TIMESTAMPTZ,
  reminder_5d_sent_at TIMESTAMPTZ,
  reminder_2d_sent_at TIMESTAMPTZ,
  reminder_1d_sent_at TIMESTAMPTZ,
  auto_submit_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_business_id ON public.disputes (business_id);
CREATE INDEX IF NOT EXISTS idx_disputes_order_id ON public.disputes (order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_disputes_status ON public.disputes (status);
CREATE INDEX IF NOT EXISTS idx_disputes_evidence_due_by ON public.disputes (evidence_due_by)
  WHERE evidence_status IN ('draft', 'ready') AND closed_at IS NULL;

COMMENT ON TABLE public.disputes IS
  'Stripe charge disputes for destination charges (platform-liable). Seller bears loss via transfer reversal.';

ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

-- Sellers may SELECT only their own business rows. Writes via service role / server actions.
CREATE POLICY disputes_select ON public.disputes
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

REVOKE ALL ON TABLE public.disputes FROM PUBLIC;
GRANT SELECT ON TABLE public.disputes TO authenticated;
GRANT ALL ON TABLE public.disputes TO service_role;
