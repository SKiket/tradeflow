-- Step 24e-3: all-or-nothing mark-returned (status + optional restock in one TX).

CREATE OR REPLACE FUNCTION public.mark_order_returned(
  p_order_id UUID,
  p_business_id UUID,
  p_restock BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_item RECORD;
  v_has_tracked BOOLEAN := false;
  v_return_restocked BOOLEAN;
  v_want_restock BOOLEAN := coalesce(p_restock, true);
BEGIN
  SELECT
    id,
    order_ref,
    business_id,
    status,
    return_restocked,
    deleted_at
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
    AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'not_found');
  END IF;

  IF v_order.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('action', 'not_found');
  END IF;

  -- Idempotent: already RETURNED → keep first choice, never restock again.
  IF v_order.status = 'RETURNED' THEN
    RETURN jsonb_build_object(
      'action', 'returned',
      'order_id', v_order.id,
      'order_ref', v_order.order_ref,
      'restocked', v_order.return_restocked,
      'already', true
    );
  END IF;

  IF v_order.status <> 'RETURN_APPROVED' THEN
    RETURN jsonb_build_object(
      'action', 'invalid_status',
      'order_id', v_order.id,
      'status', v_order.status
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.product_variants pv ON pv.id = oi.product_variant_id
    WHERE oi.order_id = p_order_id
      AND oi.business_id = p_business_id
      AND coalesce(oi.quantity, 0) > 0
      AND pv.track_inventory IS TRUE
  )
  INTO v_has_tracked;

  IF v_has_tracked THEN
    v_return_restocked := v_want_restock;
  ELSE
    v_return_restocked := NULL;
  END IF;

  UPDATE public.orders
  SET
    status = 'RETURNED',
    return_restocked = v_return_restocked,
    updated_at = NOW()
  WHERE id = p_order_id;

  INSERT INTO public.order_status_history (
    order_id,
    business_id,
    from_status,
    to_status
  ) VALUES (
    p_order_id,
    p_business_id,
    'RETURN_APPROVED',
    'RETURNED'
  );

  IF v_want_restock AND v_has_tracked THEN
    FOR v_item IN
      SELECT oi.quantity, oi.product_variant_id, pv.stock_quantity
      FROM public.order_items oi
      JOIN public.product_variants pv ON pv.id = oi.product_variant_id
      WHERE oi.order_id = p_order_id
        AND oi.business_id = p_business_id
        AND coalesce(oi.quantity, 0) > 0
        AND pv.track_inventory IS TRUE
        AND pv.business_id = p_business_id
    LOOP
      PERFORM public.adjust_variant_stock(
        v_item.product_variant_id,
        GREATEST(0, coalesce(v_item.stock_quantity, 0) + v_item.quantity),
        'restock_return',
        p_order_id
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'action', 'returned',
    'order_id', p_order_id,
    'order_ref', v_order.order_ref,
    'restocked', to_jsonb(v_return_restocked)
  );
END;
$$;

COMMENT ON FUNCTION public.mark_order_returned(UUID, UUID, BOOLEAN) IS
  'Atomic RETURN_APPROVED → RETURNED with optional restock_return stock adjust. service_role only.';

REVOKE ALL ON FUNCTION public.mark_order_returned(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_order_returned(UUID, UUID, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.mark_order_returned(UUID, UUID, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_returned(UUID, UUID, BOOLEAN) TO service_role;

-- Verify-only helpers: install/remove a trigger that fails restock_return inserts.
CREATE OR REPLACE FUNCTION public._trg_verify_force_restock_fail()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.reason = 'restock_return' THEN
    RAISE EXCEPTION 'forced_restock_fail'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._trg_verify_force_restock_fail() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._trg_verify_force_restock_fail() FROM anon;
REVOKE ALL ON FUNCTION public._trg_verify_force_restock_fail() FROM authenticated;

CREATE OR REPLACE FUNCTION public.verify_install_restock_fail_trigger()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DROP TRIGGER IF EXISTS trg_verify_force_restock_fail ON public.inventory_movements;
  CREATE TRIGGER trg_verify_force_restock_fail
    BEFORE INSERT ON public.inventory_movements
    FOR EACH ROW
    EXECUTE FUNCTION public._trg_verify_force_restock_fail();
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_remove_restock_fail_trigger()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DROP TRIGGER IF EXISTS trg_verify_force_restock_fail ON public.inventory_movements;
END;
$$;

COMMENT ON FUNCTION public.verify_install_restock_fail_trigger() IS
  'Test-only: make restock_return inventory inserts fail (service_role).';
COMMENT ON FUNCTION public.verify_remove_restock_fail_trigger() IS
  'Test-only: remove forced restock_return failure trigger (service_role).';

REVOKE ALL ON FUNCTION public.verify_install_restock_fail_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_install_restock_fail_trigger() FROM anon;
REVOKE ALL ON FUNCTION public.verify_install_restock_fail_trigger() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.verify_install_restock_fail_trigger() TO service_role;

REVOKE ALL ON FUNCTION public.verify_remove_restock_fail_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_remove_restock_fail_trigger() FROM anon;
REVOKE ALL ON FUNCTION public.verify_remove_restock_fail_trigger() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.verify_remove_restock_fail_trigger() TO service_role;
