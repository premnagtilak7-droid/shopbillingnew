-- BillFlow Step 9: owner marketing tools, promotions, and customer catalog banners.
-- Apply after the workspace_settings / staff migrations.

ALTER TABLE public.workspace_settings
  ADD COLUMN IF NOT EXISTS banner_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS banner_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS banner_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  code TEXT NOT NULL,
  discount_percentage NUMERIC NOT NULL CHECK (discount_percentage > 0 AND discount_percentage <= 100),
  max_cap_amount NUMERIC NOT NULL DEFAULT 0 CHECK (max_cap_amount >= 0),
  expiry_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, code)
);

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owners can manage promotions" ON public.promotions;
CREATE POLICY "Owners can manage promotions"
ON public.promotions FOR ALL TO authenticated
USING (public.current_user_is_owner() AND workspace_id = public.current_workspace_id())
WITH CHECK (public.current_user_is_owner() AND workspace_id = public.current_workspace_id());

CREATE INDEX IF NOT EXISTS promotions_workspace_expiry_idx
  ON public.promotions(workspace_id, expiry_date);

-- Create this public bucket once. Keep uploads owner-scoped through storage policies.
INSERT INTO storage.buckets (id, name, public)
VALUES ('marketing-banners', 'marketing-banners', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Owners can upload marketing banners" ON storage.objects;
CREATE POLICY "Owners can upload marketing banners"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'marketing-banners'
  AND public.current_user_is_owner()
  AND (storage.foldername(name))[1] = public.current_workspace_id()::text
);

DROP POLICY IF EXISTS "Owners can update marketing banners" ON storage.objects;
CREATE POLICY "Owners can update marketing banners"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'marketing-banners'
  AND public.current_user_is_owner()
  AND (storage.foldername(name))[1] = public.current_workspace_id()::text
)
WITH CHECK (
  bucket_id = 'marketing-banners'
  AND public.current_user_is_owner()
  AND (storage.foldername(name))[1] = public.current_workspace_id()::text
);

DROP POLICY IF EXISTS "Anyone can view marketing banners" ON storage.objects;
CREATE POLICY "Anyone can view marketing banners"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'marketing-banners');
