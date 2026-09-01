-- Public-read image buckets. Writes are scoped to the authenticated owner of
-- the business whose id is the first path folder (same ownership idea as table RLS).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'product-images',
    'product-images',
    TRUE,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
  ),
  (
    'business-branding',
    'business-branding',
    TRUE,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
  )
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.storage_object_owned_by_caller(object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, storage
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.businesses
    WHERE id::text = (storage.foldername(object_name))[1]
      AND owner_user_id = auth.uid()
      AND deleted_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION public.storage_object_owned_by_caller(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_object_owned_by_caller(text) TO authenticated;

DROP POLICY IF EXISTS product_images_select ON storage.objects;
DROP POLICY IF EXISTS product_images_insert ON storage.objects;
DROP POLICY IF EXISTS product_images_update ON storage.objects;
DROP POLICY IF EXISTS product_images_delete ON storage.objects;
DROP POLICY IF EXISTS business_branding_select ON storage.objects;
DROP POLICY IF EXISTS business_branding_insert ON storage.objects;
DROP POLICY IF EXISTS business_branding_update ON storage.objects;
DROP POLICY IF EXISTS business_branding_delete ON storage.objects;

CREATE POLICY product_images_select ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'product-images');

CREATE POLICY product_images_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'product-images'
    AND public.storage_object_owned_by_caller(name)
  );

CREATE POLICY product_images_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND public.storage_object_owned_by_caller(name)
  )
  WITH CHECK (
    bucket_id = 'product-images'
    AND public.storage_object_owned_by_caller(name)
  );

CREATE POLICY product_images_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND public.storage_object_owned_by_caller(name)
  );

CREATE POLICY business_branding_select ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'business-branding');

CREATE POLICY business_branding_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'business-branding'
    AND public.storage_object_owned_by_caller(name)
  );

CREATE POLICY business_branding_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'business-branding'
    AND public.storage_object_owned_by_caller(name)
  )
  WITH CHECK (
    bucket_id = 'business-branding'
    AND public.storage_object_owned_by_caller(name)
  );

CREATE POLICY business_branding_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'business-branding'
    AND public.storage_object_owned_by_caller(name)
  );
