-- Step 11: seller notification number + atomic paid-order inventory fulfilment.
--
-- seller_whatsapp_phone_e164: the seller's personal WhatsApp (notification
-- recipient). Distinct from whatsapp_phone_e164, which is the Twilio-connected
-- business line used as the FROM address for all outbound messages.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS seller_whatsapp_phone_e164 TEXT;

COMMENT ON COLUMN public.businesses.seller_whatsapp_phone_e164 IS
  'Seller personal WhatsApp in E.164 for paid-order notifications. FROM address remains whatsapp_phone_e164.';

-- Atomically convert reservations to permanent stock decrements when an order
-- is marked PAID. Idempotent: returns already_fulfilled when status is PAID.
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
  'Idempotent paid-order fulfilment: AWAITING_PAYMENT → PAID, decrement stock + release hold per line item.';
