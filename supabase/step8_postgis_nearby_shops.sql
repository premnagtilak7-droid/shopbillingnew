-- BillFlow Step 8: PostGIS-backed nearby shop discovery.
-- Apply this migration in the Supabase SQL editor.
-- In this app, public.workspace_settings is the stores table: one row per shop workspace.

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
  marketplace_published BOOLEAN NOT NULL DEFAULT false,
  latitude NUMERIC,
  longitude NUMERIC,
  opening_hours TEXT NOT NULL DEFAULT 'Mon-Sat · 9:00 AM-8:00 PM',
  delivery_available BOOLEAN NOT NULL DEFAULT false,
  delivery_radius_km NUMERIC NOT NULL DEFAULT 5,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_settings
  ADD COLUMN IF NOT EXISTS marketplace_published BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS latitude NUMERIC,
  ADD COLUMN IF NOT EXISTS longitude NUMERIC,
  ADD COLUMN IF NOT EXISTS opening_hours TEXT NOT NULL DEFAULT 'Mon-Sat · 9:00 AM-8:00 PM',
  ADD COLUMN IF NOT EXISTS delivery_available BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS location extensions.geography(POINT, 4326);

ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Customers can discover published shops" ON public.workspace_settings;
CREATE POLICY "Customers can discover published shops"
ON public.workspace_settings FOR SELECT TO authenticated
USING (marketplace_published = true OR workspace_id = public.current_workspace_id());
DROP POLICY IF EXISTS "Owners can manage branding" ON public.workspace_settings;
CREATE POLICY "Owners can manage branding"
ON public.workspace_settings FOR ALL TO authenticated
USING (public.current_user_is_owner() AND workspace_id = public.current_workspace_id())
WITH CHECK (public.current_user_is_owner() AND workspace_id = public.current_workspace_id());

-- Keep the PostGIS point synchronized with the latitude/longitude fields used by Settings.
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

-- Populate location for shops that already have coordinates.
UPDATE public.workspace_settings
SET location = extensions.ST_SetSRID(
  extensions.ST_MakePoint(longitude::double precision, latitude::double precision),
  4326
)::extensions.geography
WHERE latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND latitude BETWEEN -90 AND 90
  AND longitude BETWEEN -180 AND 180;

CREATE INDEX IF NOT EXISTS workspace_settings_location_gist_idx
  ON public.workspace_settings USING GIST (location);

CREATE INDEX IF NOT EXISTS workspace_settings_marketplace_published_idx
  ON public.workspace_settings (marketplace_published);

-- Optional compatibility for deployments that have a separate public.stores table.
DO $$
BEGIN
  IF to_regclass('public.stores') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS location extensions.geography(POINT, 4326)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS stores_location_gist_idx ON public.stores USING GIST (location)';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.get_nearby_shops(
  user_lat DOUBLE PRECISION,
  user_lng DOUBLE PRECISION,
  radius_meters DOUBLE PRECISION DEFAULT 40000
)
RETURNS TABLE (
  workspace_id UUID,
  store_name TEXT,
  tagline TEXT,
  address TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  logo_url TEXT,
  marketplace_published BOOLEAN,
  latitude NUMERIC,
  longitude NUMERIC,
  opening_hours TEXT,
  delivery_available BOOLEAN,
  delivery_radius_km NUMERIC,
  distance_meters DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  SELECT
    settings.workspace_id,
    settings.store_name,
    settings.tagline,
    settings.address,
    settings.contact_phone,
    settings.contact_email,
    settings.logo_url,
    settings.marketplace_published,
    settings.latitude,
    settings.longitude,
    settings.opening_hours,
    settings.delivery_available,
    settings.delivery_radius_km,
    extensions.ST_Distance(
      settings.location,
      extensions.ST_SetSRID(
        extensions.ST_MakePoint(user_lng, user_lat),
        4326
      )::extensions.geography
    ) AS distance_meters
  FROM public.workspace_settings AS settings
  WHERE settings.marketplace_published = true
    AND settings.location IS NOT NULL
    AND extensions.ST_DWithin(
      settings.location,
      extensions.ST_SetSRID(
        extensions.ST_MakePoint(user_lng, user_lat),
        4326
      )::extensions.geography,
      LEAST(GREATEST(radius_meters, 0), 40000)
    )
  ORDER BY settings.location <-> extensions.ST_SetSRID(
    extensions.ST_MakePoint(user_lng, user_lat),
    4326
  )::extensions.geography;
$$;

GRANT EXECUTE ON FUNCTION public.get_nearby_shops(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION)
TO authenticated;
