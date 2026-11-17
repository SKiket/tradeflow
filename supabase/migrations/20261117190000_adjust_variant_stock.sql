-- Step 24d follow-up: one-transaction stock adjust so reason GUC survives PostgREST.

CREATE OR REPLACE FUNCTION public.adjust_variant_stock(
  p_variant_id UUID,
  p_stock_quantity INTEGER,
  p_reason TEXT DEFAULT 'other',
  p_order_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
BEGIN
  SELECT business_id
  INTO v_business_id
  FROM public.product_variants
  WHERE id = p_variant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'variant_not_found';
  END IF;

  -- service_role has no auth.uid(); sellers must own the shop.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.businesses
      WHERE id = v_business_id
        AND owner_user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not_allowed';
    END IF;
  END IF;

  PERFORM public.set_inventory_movement_context(p_reason, p_order_id);

  UPDATE public.product_variants
  SET
    stock_quantity = GREATEST(0, coalesce(p_stock_quantity, 0)),
    updated_at = NOW()
  WHERE id = p_variant_id;
END;
$$;

COMMENT ON FUNCTION public.adjust_variant_stock(UUID, INTEGER, TEXT, UUID) IS
  'Sets inventory reason context and updates stock_quantity in one transaction (PostgREST-safe).';

REVOKE ALL ON FUNCTION public.adjust_variant_stock(UUID, INTEGER, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.adjust_variant_stock(UUID, INTEGER, TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.adjust_variant_stock(UUID, INTEGER, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_variant_stock(UUID, INTEGER, TEXT, UUID) TO service_role;
