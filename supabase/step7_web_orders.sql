-- BillFlow Step 7: persistent customer pickup orders for the POS Web Orders queue.
-- Apply after step6_multitenant_staff.sql and enable Realtime for public.web_orders.

CREATE TABLE IF NOT EXISTS public.web_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  order_id TEXT NOT NULL,
  customer_id UUID REFERENCES public.customers(id),
  customer_name TEXT NOT NULL DEFAULT 'Customer',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'ready', 'completed', 'cancelled')),
  pickup_window TEXT NOT NULL DEFAULT 'Ready in 30 mins',
  pickup_time TIMESTAMPTZ,
  payment_method TEXT NOT NULL DEFAULT 'Cash',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  subtotal NUMERIC NOT NULL DEFAULT 0,
  tax NUMERIC NOT NULL DEFAULT 0,
  total NUMERIC NOT NULL DEFAULT 0,
  qr_token TEXT NOT NULL,
  claimed_at TIMESTAMPTZ,
  claimed_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, order_id),
  UNIQUE (workspace_id, qr_token)
);

CREATE TABLE IF NOT EXISTS public.web_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.web_orders(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  product_id UUID,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC NOT NULL DEFAULT 0,
  tax_rate NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.web_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can read web orders" ON public.web_orders;
CREATE POLICY "Workspace members can read web orders"
ON public.web_orders FOR SELECT TO authenticated
USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS "Workspace staff can create web orders" ON public.web_orders;
DROP POLICY IF EXISTS "Customers can create published shop orders" ON public.web_orders;
CREATE POLICY "Workspace staff can create web orders"
ON public.web_orders FOR INSERT TO authenticated
WITH CHECK (workspace_id = public.current_workspace_id());
CREATE POLICY "Customers can create published shop orders"
ON public.web_orders FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.workspace_settings settings
    WHERE settings.workspace_id = web_orders.workspace_id
      AND settings.marketplace_published = true
  )
);

DROP POLICY IF EXISTS "Workspace staff can update web orders" ON public.web_orders;
CREATE POLICY "Workspace staff can update web orders"
ON public.web_orders FOR UPDATE TO authenticated
USING (workspace_id = public.current_workspace_id())
WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS "Workspace members can read web order items" ON public.web_order_items;
CREATE POLICY "Workspace members can read web order items"
ON public.web_order_items FOR SELECT TO authenticated
USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS "Workspace members can create web order items" ON public.web_order_items;
CREATE POLICY "Workspace members can create web order items"
ON public.web_order_items FOR INSERT TO authenticated
WITH CHECK (workspace_id = public.current_workspace_id());

CREATE INDEX IF NOT EXISTS web_orders_workspace_status_idx
  ON public.web_orders(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS web_orders_workspace_qr_idx
  ON public.web_orders(workspace_id, qr_token);
CREATE INDEX IF NOT EXISTS web_order_items_order_idx
  ON public.web_order_items(order_id);

-- Supabase Dashboard: Database > Publications > supabase_realtime > add web_orders.
ALTER TABLE public.web_orders REPLICA IDENTITY FULL;
