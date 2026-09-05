-- BillFlow Step 4: workspace-scoped store and invoice branding.
alter table if exists public.invoices
  add column if not exists discount numeric not null default 0;

create table if not exists public.workspace_settings (
  workspace_id uuid primary key,
  store_name text not null default 'BillFlow Store',
  tagline text not null default 'Simple billing for growing shops',
  address text not null default '',
  contact_phone text not null default '',
  contact_email text not null default '',
  tax_id text not null default '',
  upi_id text not null default '',
  logo_url text not null default '',
  footer_note text not null default 'Thank you for shopping with us! No refunds without receipt.',
  updated_at timestamptz not null default now()
);

alter table public.workspace_settings enable row level security;

drop policy if exists "Workspace members can view branding" on public.workspace_settings;
drop policy if exists "Owners can manage branding" on public.workspace_settings;

create policy "Workspace members can view branding"
on public.workspace_settings for select to authenticated
using (workspace_id = public.current_workspace_id());

create policy "Owners can manage branding"
on public.workspace_settings for all to authenticated
using (public.current_user_is_owner() and workspace_id = public.current_workspace_id())
with check (public.current_user_is_owner() and workspace_id = public.current_workspace_id());

create or replace function public.touch_workspace_settings_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspace_settings_updated_at on public.workspace_settings;
create trigger workspace_settings_updated_at
before update on public.workspace_settings
for each row execute function public.touch_workspace_settings_updated_at();
