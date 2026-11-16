-- Step 21b: dispute cost recovery, early fraud warnings, complaint urgency.

-- ---------------------------------------------------------------------------
-- disputes: recovery columns (additive)
-- ---------------------------------------------------------------------------
ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS recovery_status TEXT
    CHECK (
      recovery_status IS NULL
      OR recovery_status IN (
        'not_needed',
        'pending',
        'recovered',
        'partial',
        'unpaid'
      )
    ),
  ADD COLUMN IF NOT EXISTS fee_pence INTEGER,
  ADD COLUMN IF NOT EXISTS recovered_via_reversal_pence INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovered_via_account_debit_pence INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovered_via_invoice_pence INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS recovery_notes TEXT,
  ADD COLUMN IF NOT EXISTS recovery_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cheaper_resolution_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cheaper_resolution_copied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_charge_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.disputes.recovery_status IS
  'not_needed | pending | recovered | partial | unpaid — seller liability recovery after close.';
COMMENT ON COLUMN public.disputes.fee_pence IS
  'Dispute fee charged back to seller (DISPUTE_FEE_PENCE). Platform absorbs app fee + processing fee.';
COMMENT ON COLUMN public.disputes.recovery_notes IS
  'Machine-readable recovery log; no personal data.';

CREATE INDEX IF NOT EXISTS idx_disputes_recovery_status
  ON public.disputes (business_id, recovery_status)
  WHERE recovery_status IN ('pending', 'partial', 'unpaid');

CREATE INDEX IF NOT EXISTS idx_disputes_recovery_invoice_id
  ON public.disputes (recovery_invoice_id)
  WHERE recovery_invoice_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- businesses: dispute balance hold (additive)
-- ---------------------------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS dispute_balance_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dispute_balance_owed_pence INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.businesses.dispute_balance_hold IS
  'When true, canAcceptOrders is false with reason dispute_balance_unpaid.';
COMMENT ON COLUMN public.businesses.dispute_balance_owed_pence IS
  'Sum of unpaid dispute recovery amounts (pence). No personal data.';

-- ---------------------------------------------------------------------------
-- orders / customers: seller attention urgency (complaint detection)
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS seller_attention_urgent_at TIMESTAMPTZ;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS seller_attention_urgent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.seller_attention_urgent_at IS
  'Set when inbound payment-complaint phrases match; surfaces in needs-attention.';
COMMENT ON COLUMN public.customers.seller_attention_urgent_at IS
  'Conversation-level urgent flag for payment complaints.';

-- ---------------------------------------------------------------------------
-- fraud_warnings (Radar early fraud warnings)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_warnings (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  order_id UUID REFERENCES public.orders (id) ON DELETE RESTRICT,
  stripe_efw_id TEXT NOT NULL UNIQUE,
  stripe_charge_id TEXT NOT NULL,
  actionable BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'refunded', 'dismissed', 'disputed')),
  seller_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_warnings_business_id
  ON public.fraud_warnings (business_id);
CREATE INDEX IF NOT EXISTS idx_fraud_warnings_order_id
  ON public.fraud_warnings (order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fraud_warnings_open
  ON public.fraud_warnings (business_id, status)
  WHERE status = 'open';

COMMENT ON TABLE public.fraud_warnings IS
  'Stripe Radar early fraud warnings. Ids only — no personal data.';

ALTER TABLE public.fraud_warnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY fraud_warnings_select ON public.fraud_warnings
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

REVOKE ALL ON TABLE public.fraud_warnings FROM PUBLIC;
GRANT SELECT ON TABLE public.fraud_warnings TO authenticated;
GRANT ALL ON TABLE public.fraud_warnings TO service_role;
