-- BillFlow Step 3: staff roles, permissions, activity, and owner-scoped profile management.
-- Apply with Supabase migrations before enabling the Settings staff directory.

alter table public.profiles
  add column if not exists can_apply_discounts boolean not null default false,
  add column if not exists can_delete_cart_items boolean not null default false,
  add column if not exists can_view_reports boolean not null default false,
  add column if not exists can_edit_inventory boolean not null default false,
  add column if not exists is_active boolean not null default true,
  add column if not exists last_active_at timestamptz,
  add column if not exists pin_hash text;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (lower(role) in ('owner', 'employee'));

create index if not exists profiles_workspace_role_idx on public.profiles(workspace_id, role);

alter table public.profiles enable row level security;

create or replace function public.current_workspace_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$ select workspace_id from public.profiles where id = auth.uid() and is_active = true limit 1 $$;

drop policy if exists "Profiles are visible to workspace members" on public.profiles;
drop policy if exists "Owners can manage workspace staff" on public.profiles;

create policy "Profiles are visible to workspace members"
on public.profiles for select to authenticated
using (
  id = auth.uid()
  or workspace_id = public.current_workspace_id()
);

create policy "Owners can manage workspace staff"
on public.profiles for all to authenticated
using (
  workspace_id = public.current_workspace_id()
  and exists (select 1 from public.profiles p where p.id = auth.uid() and lower(p.role) = 'owner' and p.is_active = true)
)
with check (
  workspace_id = public.current_workspace_id()
  and exists (select 1 from public.profiles p where p.id = auth.uid() and lower(p.role) = 'owner' and p.is_active = true)
  and lower(role) in ('owner', 'employee')
);

-- Owners retain all permissions; employees start with least privilege.
update public.profiles set
  can_apply_discounts = case when lower(role) = 'owner' then true else coalesce(can_apply_discounts, false) end,
  can_delete_cart_items = case when lower(role) = 'owner' then true else coalesce(can_delete_cart_items, false) end,
  can_view_reports = case when lower(role) = 'owner' then true else coalesce(can_view_reports, false) end,
  can_edit_inventory = case when lower(role) = 'owner' then true else coalesce(can_edit_inventory, false) end;
