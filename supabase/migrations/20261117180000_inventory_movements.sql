-- Step 24d: append-only inventory movement history (trigger on stock_quantity).

CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  variant_id UUID NOT NULL REFERENCES public.product_variants (id) ON DELETE RESTRICT,
  change INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  reason TEXT NOT NULL
    CHECK (reason IN (
      'sale',
      'restock_cancellation',
      'restock_return',
      'manual_adjustment',
      'initial',
      'other'
    )),
  order_id UUID REFERENCES public.orders (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inventory_movements_variant_created_idx
  ON public.inventory_movements (variant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_movements_business_created_idx
  ON public.inventory_movements (business_id, created_at DESC);

COMMENT ON TABLE public.inventory_movements IS
  'Append-only stock_quantity ledger. Written by trigger; sellers SELECT only. No buyer PII.';

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inventory_movements FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_movements FROM anon;
REVOKE ALL ON TABLE public.inventory_movements FROM authenticated;
GRANT SELECT ON TABLE public.inventory_movements TO authenticated;
GRANT ALL ON TABLE public.inventory_movements TO service_role;

DROP POLICY IF EXISTS inventory_movements_select_own ON public.inventory_movements;
CREATE POLICY inventory_movements_select_own
  ON public.inventory_movements
  FOR SELECT
  TO authenticated
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_user_id = auth.uid()
    )
  );

-- Session context for optional reason / order_id (transaction-local).
CREATE OR REPLACE FUNCTION public.set_inventory_movement_context(
  p_reason TEXT DEFAULT NULL,
  p_order_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason TEXT;
BEGIN
  v_reason := lower(trim(coalesce(p_reason, '')));
  IF v_reason = '' THEN
    v_reason := 'other';
  END IF;
  IF v_reason NOT IN (
    'sale',
    'restock_cancellation',
    'restock_return',
    'manual_adjustment',
    'initial',
    'other'
  ) THEN
    v_reason := 'other';
  END IF;
  PERFORM set_config('app.inventory_reason', v_reason, true);
  PERFORM set_config(
    'app.inventory_order_id',
    coalesce(p_order_id::text, ''),
    true
  );
END;
$$;

COMMENT ON FUNCTION public.set_inventory_movement_context(TEXT, UUID) IS
  'Sets transaction-local reason/order_id for the inventory_movements trigger.';

REVOKE ALL ON FUNCTION public.set_inventory_movement_context(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_inventory_movement_context(TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_inventory_movement_context(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_inventory_movement_context(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.inventory_movements_from_variant_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_change INTEGER;
  v_reason TEXT;
  v_order_id UUID;
  v_raw_order TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_change := coalesce(NEW.stock_quantity, 0);
  ELSE
    v_change := coalesce(NEW.stock_quantity, 0) - coalesce(OLD.stock_quantity, 0);
  END IF;

  IF v_change = 0 THEN
    RETURN NEW;
  END IF;

  v_reason := nullif(current_setting('app.inventory_reason', true), '');
  IF v_reason IS NULL OR v_reason = '' THEN
    IF TG_OP = 'INSERT' THEN
      v_reason := 'initial';
    ELSE
      v_reason := 'other';
    END IF;
  END IF;

  IF v_reason NOT IN (
    'sale',
    'restock_cancellation',
    'restock_return',
    'manual_adjustment',
    'initial',
    'other'
  ) THEN
    v_reason := 'other';
  END IF;

  v_raw_order := nullif(current_setting('app.inventory_order_id', true), '');
  IF v_raw_order IS NOT NULL AND v_raw_order <> '' THEN
    BEGIN
      v_order_id := v_raw_order::uuid;
    EXCEPTION WHEN others THEN
      v_order_id := NULL;
    END;
  END IF;

  INSERT INTO public.inventory_movements (
    business_id,
    variant_id,
    change,
    stock_after,
    reason,
    order_id
  ) VALUES (
    NEW.business_id,
    NEW.id,
    v_change,
    coalesce(NEW.stock_quantity, 0),
    v_reason,
    v_order_id
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.inventory_movements_from_variant_stock() IS
  'AFTER INSERT/UPDATE stock_quantity → append inventory_movements row.';

REVOKE ALL ON FUNCTION public.inventory_movements_from_variant_stock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inventory_movements_from_variant_stock() FROM anon;
REVOKE ALL ON FUNCTION public.inventory_movements_from_variant_stock() FROM authenticated;

DROP TRIGGER IF EXISTS trg_inventory_movements_stock ON public.product_variants;
CREATE TRIGGER trg_inventory_movements_stock
  AFTER INSERT OR UPDATE OF stock_quantity
  ON public.product_variants
  FOR EACH ROW
  EXECUTE FUNCTION public.inventory_movements_from_variant_stock();

-- Label paid fulfilment as sale (single obvious safe place in existing SQL).
CREATE OR REPLACE FUNCTION public.fulfil_paid_order(p_order_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_item RECORD;
BEGIN
  SELECT id, business_id, status, order_ref
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_order.status = 'PAID' THEN
    RETURN 'already_fulfilled';
  END IF;

  IF v_order.status <> 'AWAITING_PAYMENT' THEN
    RETURN 'skipped_' || v_order.status;
  END IF;

  PERFORM public.set_inventory_movement_context('sale', p_order_id);

  FOR v_item IN
    SELECT oi.quantity, oi.product_variant_id, pv.track_inventory
    FROM public.order_items oi
    JOIN public.product_variants pv ON pv.id = oi.product_variant_id
    WHERE oi.order_id = p_order_id
  LOOP
    IF v_item.track_inventory THEN
      UPDATE public.product_variants
      SET
        stock_quantity = GREATEST(0, stock_quantity - v_item.quantity),
        reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity),
        updated_at = NOW()
      WHERE id = v_item.product_variant_id;
    END IF;
  END LOOP;

  UPDATE public.orders
  SET
    status = 'PAID',
    reserved_until = NULL,
    updated_at = NOW()
  WHERE id = p_order_id;

  INSERT INTO public.order_status_history (
    order_id,
    business_id,
    from_status,
    to_status
  ) VALUES (
    p_order_id,
    v_order.business_id,
    'AWAITING_PAYMENT',
    'PAID'
  );

  RETURN 'fulfilled';
END;
$$;

COMMENT ON FUNCTION public.fulfil_paid_order(UUID) IS
  'Idempotent paid-order fulfilment: AWAITING_PAYMENT → PAID, decrement stock + release hold; labels inventory sale.';

REVOKE ALL ON FUNCTION public.fulfil_paid_order(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfil_paid_order(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_paid_order(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_paid_order(UUID) TO service_role;
