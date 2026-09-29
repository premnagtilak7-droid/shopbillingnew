-- BillFlow Step 10: standalone repair for Owner Settings save errors.
-- Run this in the SAME Supabase project referenced by VITE_SUPABASE_URL.
-- It is safe to run more than once.

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.workspace_settings (
  workspace_id UUID PRIMARY KEY,
  store_name TEXT NOT NULL DEFAULT 'BillFlow Store',
  tagline TEXT NOT NULL DEFAULT 'Simple billing for growing shops',
  address TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  upi_id TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  footer_note TEXT NOT NULL DEFAULT 'Thank you for shopping with us! No refunds without receipt.',
  categories TEXT NOT NULL DEFAULT 'Hardware',
  marketplace_published BOOLEAN NOT NULL DEFAULT false,
  latitude NUMERIC,
  longitude NUMERIC,
  location extensions.geography(POINT, 4326),
  opening_hours TEXT NOT NULL DEFAULT 'Mon-Sat · 9:00 AM-8:00 PM',
  delivery_available BOOLEAN NOT NULL DEFAULT false,
  delivery_radius_km NUMERIC NOT NULL DEFAULT 5,
  banner_url TEXT NOT NULL DEFAULT '',
  banner_text TEXT NOT NULL DEFAULT '',
  banner_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_settings
  ADD COLUMN IF NOT EXISTS store_name TEXT NOT NULL DEFAULT 'BillFlow Store',
  ADD COLUMN IF NOT EXISTS tagline TEXT NOT NULL DEFAULT 'Simple billing for growing shops',
  ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_phone TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tax_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS upi_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS footer_note TEXT NOT NULL DEFAULT 'Thank you for shopping with us! No refunds without receipt.',
  ADD COLUMN IF NOT EXISTS categories TEXT NOT NULL DEFAULT 'Hardware',
  ADD COLUMN IF NOT EXISTS marketplace_published BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS latitude NUMERIC,
  ADD COLUMN IF NOT EXISTS longitude NUMERIC,
  ADD COLUMN IF NOT EXISTS location extensions.geography(POINT, 4326),
  ADD COLUMN IF NOT EXISTS opening_hours TEXT NOT NULL DEFAULT 'Mon-Sat · 9:00 AM-8:00 PM',
  ADD COLUMN IF NOT EXISTS delivery_available BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS banner_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS banner_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS banner_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can view branding" ON public.workspace_settings;
DROP POLICY IF EXISTS "Customers can discover published shops" ON public.workspace_settings;
CREATE POLICY "Customers can discover published shops"
ON public.workspace_settings FOR SELECT TO authenticated
USING (
  marketplace_published = true
  OR EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.id = auth.uid()
      AND profile.workspace_id = workspace_settings.workspace_id
  )
);

DROP POLICY IF EXISTS "Owners can manage branding" ON public.workspace_settings;
CREATE POLICY "Owners can manage branding"
ON public.workspace_settings FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.id = auth.uid()
      AND profile.workspace_id = workspace_settings.workspace_id
      AND lower(profile.role) = 'owner'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.id = auth.uid()
      AND profile.workspace_id = workspace_settings.workspace_id
      AND lower(profile.role) = 'owner'
  )
);

CREATE OR REPLACE FUNCTION public.sync_workspace_settings_location()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  IF NEW.latitude IS NULL OR NEW.longitude IS NULL
     OR NEW.latitude < -90 OR NEW.latitude > 90
     OR NEW.longitude < -180 OR NEW.longitude > 180 THEN
    NEW.location = NULL;
  ELSE
    NEW.location = extensions.ST_SetSRID(
      extensions.ST_MakePoint(NEW.longitude::double precision, NEW.latitude::double precision),
      4326
    )::extensions.geography;
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_settings_location_sync ON public.workspace_settings;
CREATE TRIGGER workspace_settings_location_sync
BEFORE INSERT OR UPDATE OF latitude, longitude ON public.workspace_settings
FOR EACH ROW EXECUTE FUNCTION public.sync_workspace_settings_location();

CREATE INDEX IF NOT EXISTS workspace_settings_location_gist_idx
  ON public.workspace_settings USING GIST (location);

-- Ask PostgREST to reload its table/schema cache immediately.
NOTIFY pgrst, 'reload schema';

-- Verification:
-- SELECT to_regclass('public.workspace_settings');
