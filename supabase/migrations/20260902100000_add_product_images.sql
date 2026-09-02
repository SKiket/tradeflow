-- Per-product image gallery. products.photo_url remains the derived cover
-- (the row at sort_order 0, or NULL when the gallery is empty).

CREATE TABLE public.product_images (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses (id) ON DELETE RESTRICT,
  image_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_images_sort_order_check CHECK (sort_order >= 0),
  CONSTRAINT product_images_image_url_check CHECK (char_length(btrim(image_url)) > 0)
);

CREATE INDEX idx_product_images_product_id ON public.product_images (product_id, sort_order);
CREATE INDEX idx_product_images_business_id ON public.product_images (business_id);

COMMENT ON TABLE public.product_images IS
  'Gallery images for a product, shared across all of its variants. sort_order 0 is the cover.';
COMMENT ON COLUMN public.product_images.business_id IS
  'Denormalised tenant id, matching product_variants, so RLS and queries stay consistent.';
COMMENT ON COLUMN public.product_images.sort_order IS
  '0-based position. The image at 0 is synced onto products.photo_url.';

-- Cover image: always the gallery row at sort_order 0 (NULL if none).
CREATE OR REPLACE FUNCTION public.sync_product_photo_url_from_gallery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_product_id uuid;
  cover text;
BEGIN
  target_product_id := COALESCE(NEW.product_id, OLD.product_id);

  SELECT image_url
    INTO cover
    FROM public.product_images
   WHERE product_id = target_product_id
     AND sort_order = 0
   LIMIT 1;

  UPDATE public.products
     SET photo_url = cover
   WHERE id = target_product_id
     AND photo_url IS DISTINCT FROM cover;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_product_photo_url_from_gallery() FROM PUBLIC;

CREATE TRIGGER product_images_sync_photo_url
  AFTER INSERT OR UPDATE OR DELETE ON public.product_images
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_product_photo_url_from_gallery();

CREATE OR REPLACE FUNCTION public.enforce_product_images_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.products p
    WHERE p.id = NEW.product_id
      AND p.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'product_images.business_id must match the product';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.product_images
    WHERE product_id = NEW.product_id
  ) > 6 THEN
    RAISE EXCEPTION 'A product can have at most 6 images';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_product_images_cap() FROM PUBLIC;

CREATE TRIGGER product_images_enforce_cap
  AFTER INSERT OR UPDATE OF product_id, business_id ON public.product_images
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_product_images_cap();

INSERT INTO public.product_images (product_id, business_id, image_url, sort_order)
SELECT p.id, p.business_id, p.photo_url, 0
FROM public.products p
WHERE p.photo_url IS NOT NULL
  AND btrim(p.photo_url) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.product_images i WHERE i.product_id = p.id
  );

ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;

-- Owner-scoped writes/reads, matching products / product_variants.
CREATE POLICY product_images_select ON public.product_images
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

CREATE POLICY product_images_insert ON public.product_images
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_id
        AND p.business_id = product_images.business_id
    )
  );

CREATE POLICY product_images_update ON public.product_images
  FOR UPDATE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  )
  WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_id
        AND p.business_id = product_images.business_id
    )
  );

CREATE POLICY product_images_delete ON public.product_images
  FOR DELETE TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_user_id = auth.uid())
  );

-- Public reads for images on active products — the storefront catalog is the
-- same set of rows (loaded via service role today; this policy matches that
-- public-read surface for anyone querying the table directly).
CREATE POLICY product_images_select_public ON public.product_images
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.products p
      WHERE p.id = product_images.product_id
        AND p.active = TRUE
        AND p.deleted_at IS NULL
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_images TO authenticated;
GRANT SELECT ON public.product_images TO anon;
