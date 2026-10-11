-- 62 收緊權限（審查後）  先執行此 SQL，再 push 程式碼；本檔可重複執行
-- (1) 報到人員（staff）只能改報名的「狀態」，不能改姓名、電話、欄位內容、所屬活動或報名人。
--     主辦（organizer）與超級管理者不受影響；Edge Function（service role）與 SQL Editor 不受影響。
-- (2) 匯出範本：所有管理者仍可讀取與新增；只有超級管理者或建立者可以修改／刪除。

-- ---------- (1) registrations ----------
create or replace function public.registrations_limit_staff_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- service role / SQL Editor（沒有登入使用者）不受限
  if auth.uid() is null then
    return new;
  end if;
  if is_super_admin() or has_event_role(old.event_id, array['organizer']::text[]) then
    return new;
  end if;
  -- 其餘（報到人員）只能改 status 與 updated_at
  if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
    raise exception '報到人員只能更新報名狀態。' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists registrations_limit_staff_update on public.registrations;
create trigger registrations_limit_staff_update
  before update on public.registrations
  for each row execute function public.registrations_limit_staff_update();

-- ---------- (2) csv_export_templates ----------
alter table public.csv_export_templates
  add column if not exists created_by uuid default auth.uid();

drop policy if exists "admins manage csv templates" on public.csv_export_templates;
drop policy if exists "admins read csv templates" on public.csv_export_templates;
drop policy if exists "admins add csv templates" on public.csv_export_templates;
drop policy if exists "owner or super admin change csv templates" on public.csv_export_templates;
drop policy if exists "owner or super admin delete csv templates" on public.csv_export_templates;

create policy "admins read csv templates" on public.csv_export_templates
  for select to authenticated
  using (exists (select 1 from public.admin_roles r where r.admin_user_id = auth.uid()));

create policy "admins add csv templates" on public.csv_export_templates
  for insert to authenticated
  with check (
    exists (select 1 from public.admin_roles r where r.admin_user_id = auth.uid())
    and (created_by = auth.uid() or created_by is null)
  );

create policy "owner or super admin change csv templates" on public.csv_export_templates
  for update to authenticated
  using (is_super_admin() or created_by = auth.uid())
  with check (is_super_admin() or created_by = auth.uid());

create policy "owner or super admin delete csv templates" on public.csv_export_templates
  for delete to authenticated
  using (is_super_admin() or created_by = auth.uid());
-- 注意：既有範本的 created_by 是空的，所以只有超級管理者能改／刪；其他管理者可讀、可新增自己的。

-- 還原方式（若需要）：
--   drop trigger registrations_limit_staff_update on public.registrations;
--   重建舊政策：create policy "admins manage csv templates" on public.csv_export_templates for all to authenticated
--     using (exists (select 1 from public.admin_roles r where r.admin_user_id = auth.uid()))
--     with check (exists (select 1 from public.admin_roles r where r.admin_user_id = auth.uid()));
