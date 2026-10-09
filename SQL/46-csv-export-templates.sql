-- 46: CSV 匯出「自訂欄位」範本（Dashboard 匯出前可新增欄位，並另存為範本）
create table if not exists public.csv_export_templates (
  id uuid primary key default gen_random_uuid(),
  export_key text not null,            -- registrants / task_view / assign_list / profiles
  name text not null,
  columns jsonb not null default '[]'::jsonb,   -- [{ "name": "備註", "def": "" }, ...]
  created_at timestamptz not null default now(),
  unique (export_key, name)
);

alter table public.csv_export_templates enable row level security;

drop policy if exists "admins manage csv templates" on public.csv_export_templates;
create policy "admins manage csv templates" on public.csv_export_templates
  for all to authenticated
  using (exists (select 1 from public.admin_roles r where r.admin_user_id = auth.uid()))
  with check (exists (select 1 from public.admin_roles r where r.admin_user_id = auth.uid()));
