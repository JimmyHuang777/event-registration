-- =========================================================
-- 53 壇組長自動管理所屬壇的活動
-- 哪些組的「組長」可以編輯所屬壇的活動（不含新增、啟用/停用、刪除）。
-- 預設：佛堂(shrine)、庶務(general)、住壇(resident)；天廚(kitchen)不含。
-- Dashboard「管理者權限」可勾選調整；也可直接改這張表。
-- =========================================================
create table if not exists public.altar_manager_teams (
  team text primary key
);

insert into public.altar_manager_teams (team)
values ('shrine'), ('general'), ('resident')
on conflict do nothing;

alter table public.altar_manager_teams enable row level security;

drop policy if exists "super admins manage altar_manager_teams" on public.altar_manager_teams;
create policy "super admins manage altar_manager_teams"
  on public.altar_manager_teams for all to authenticated
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists "authenticated read altar_manager_teams" on public.altar_manager_teams;
create policy "authenticated read altar_manager_teams"
  on public.altar_manager_teams for select to authenticated
  using (true);
