-- BillFlow Step 5: product enrichment fields for barcode lookup.
alter table public.products
  add column if not exists category text not null default '',
  add column if not exists image_url text not null default '',
  add column if not exists description text not null default '';
