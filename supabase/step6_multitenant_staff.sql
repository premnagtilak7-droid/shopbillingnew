-- BillFlow Step 6: strict workspace isolation and Owner -> staff relationships.
-- Apply after step3_staff_management.sql.

CREATE TABLE IF NOT EXISTS public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, phone)
);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Workspace members can read customers" ON public.customers;
CREATE POLICY "Workspace members can read customers"
ON public.customers FOR SELECT TO authenticated
USING (workspace_id = public.current_workspace_id());
DROP POLICY IF EXISTS "Workspace members can create customers" ON public.customers;
CREATE POLICY "Workspace members can create customers"
ON public.customers FOR INSERT TO authenticated
WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS username TEXT;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS created_by_staff_id UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id);

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

UPDATE public.profiles
SET owner_id = id
WHERE owner_id IS NULL AND LOWER(role) = 'owner';

UPDATE public.profiles employee
SET owner_id = owner.id
FROM public.profiles owner
WHERE employee.owner_id IS NULL
  AND LOWER(employee.role) IN ('employee', 'cashier', 'manager')
  AND LOWER(owner.role) = 'owner'
  AND owner.workspace_id = employee.workspace_id;

UPDATE public.invoice_items item
SET workspace_id = invoice.workspace_id
FROM public.invoices invoice
WHERE item.invoice_id = invoice.id
  AND item.workspace_id IS NULL;

ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_workspace_id_not_null
  CHECK (workspace_id IS NOT NULL) NOT VALID;

-- Support Owner, manager, and cashier staff roles.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (LOWER(role) IN ('owner', 'employee', 'manager', 'cashier'));

CREATE INDEX IF NOT EXISTS profiles_owner_workspace_idx
  ON public.profiles(owner_id, workspace_id);
CREATE INDEX IF NOT EXISTS invoices_workspace_creator_idx
  ON public.invoices(workspace_id, created_by_staff_id);
CREATE INDEX IF NOT EXISTS invoice_items_workspace_idx
  ON public.invoice_items(workspace_id);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can read products" ON public.products;
CREATE POLICY "Workspace members can read products"
ON public.products FOR SELECT TO authenticated
USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS "Workspace members can read invoices" ON public.invoices;
CREATE POLICY "Workspace members can read invoices"
ON public.invoices FOR SELECT TO authenticated
USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS "Workspace members can read invoice items" ON public.invoice_items;
CREATE POLICY "Workspace members can read invoice items"
ON public.invoice_items FOR SELECT TO authenticated
USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS "Workspace staff can create invoices" ON public.invoices;
CREATE POLICY "Workspace staff can create invoices"
ON public.invoices FOR INSERT TO authenticated
WITH CHECK (
  workspace_id = public.current_workspace_id()
  AND EXISTS (
    SELECT 1 FROM public.profiles staff
    WHERE staff.id = created_by_staff_id
      AND staff.workspace_id = public.current_workspace_id()
      AND staff.is_active = true
  )
);

DROP POLICY IF EXISTS "Workspace staff can create invoice items" ON public.invoice_items;
CREATE POLICY "Workspace staff can create invoice items"
ON public.invoice_items FOR INSERT TO authenticated
WITH CHECK (workspace_id = public.current_workspace_id());
