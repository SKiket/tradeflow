-- Step 19: GDPR deletion / export accountability.
-- App constants: RETAINED_RECORD_YEARS = 6, SHOP_CLOSE_GRACE_DAYS = 30
-- (defined in src/lib/privacy/constants.ts — do not duplicate as DB config).

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.anonymised_at IS
  'Set when buyer PII was stripped for erasure; totals/status retained for UK tax.';

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;

COMMENT ON COLUMN public.businesses.closed_at IS
  'Seller closed the shop; storefront shows closed; WhatsApp gets closed reply.';
COMMENT ON COLUMN public.businesses.purge_after IS
  'After this timestamp the shop-purge cron may permanently erase personal data.';

CREATE TABLE IF NOT EXISTS public.deletion_requests (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID REFERENCES public.businesses (id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('customer', 'seller_account')),
  subject_id UUID NOT NULL,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('seller', 'operator')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'blocked')),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS deletion_requests_business_idx
  ON public.deletion_requests (business_id);

CREATE INDEX IF NOT EXISTS deletion_requests_reapply_idx
  ON public.deletion_requests (status, subject_type, subject_id)
  WHERE status = 'completed';

COMMENT ON TABLE public.deletion_requests IS
  'Accountability log for erasure. Holds NO personal data (no phone/name/email). '
  'subject_id is the customer or business UUID for re-apply after restore.';

ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deletion_requests_select ON public.deletion_requests;
CREATE POLICY deletion_requests_select ON public.deletion_requests
  FOR SELECT
  USING (
    business_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.businesses b
      WHERE b.id = deletion_requests.business_id
        AND b.owner_user_id = auth.uid()
        AND b.deleted_at IS NULL
    )
  );

-- Writes are service-role only (no INSERT/UPDATE/DELETE policies for authenticated).

-- pending_replays had no RLS; enable and allow owners to select/delete their rows
-- so seller-scoped erase paths can clear queues without widening service-role use.
ALTER TABLE public.pending_replays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pending_replays_select ON public.pending_replays;
CREATE POLICY pending_replays_select ON public.pending_replays
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.businesses b
      WHERE b.id = pending_replays.business_id
        AND b.owner_user_id = auth.uid()
        AND b.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS pending_replays_delete ON public.pending_replays;
CREATE POLICY pending_replays_delete ON public.pending_replays
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.businesses b
      WHERE b.id = pending_replays.business_id
        AND b.owner_user_id = auth.uid()
        AND b.deleted_at IS NULL
    )
  );
