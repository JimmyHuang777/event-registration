-- 51: 火車時刻表改存資料庫（瑞穗站）。活動的「火車車次」欄位選項由此表產生。
create table if not exists public.train_schedule (
  id uuid primary key default gen_random_uuid(),
  train_no text not null unique,       -- 車次，例：402
  train_type text not null,            -- 車種，例：普悠瑪
  arrive_time text not null,           -- 瑞穗站抵達時間 HH:MM
  depart_time text,                    -- 瑞穗站開車時間 HH:MM（選填）
  route text,                          -- 運行區間，例：樹林 → 臺東
  note text,                           -- 備註／行駛日
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists train_schedule_arrive_idx on public.train_schedule (arrive_time);

alter table public.train_schedule enable row level security;

drop policy if exists "authenticated read train schedule" on public.train_schedule;
create policy "authenticated read train schedule" on public.train_schedule
  for select to authenticated using (true);

drop policy if exists "super admins manage train schedule" on public.train_schedule;
create policy "super admins manage train schedule" on public.train_schedule
  for all to authenticated
  using (is_super_admin())
  with check (is_super_admin());
-- 手機端（LINE）的讀取走 events-admin-api（service role）。

insert into public.train_schedule (train_no, train_type, arrive_time, depart_time, route, note) values
  ('306','自強 (3000)','07:15','07:19','花蓮 → 新左營','週末南下首班對號車'),
  ('402','普悠瑪','08:58','08:59','樹林 → 知本','每日行駛'),
  ('406','自強 (3000)','09:51','09:52','樹林 → 臺東','每日行駛'),
  ('410','自強 (3000)','11:15','11:16','樹林 → 新左營','每日行駛'),
  ('472','自強 (3000)','11:58','12:00','員林 → 臺東','每日行駛'),
  ('416','太魯閣','12:35','12:36','樹林 → 臺東','新加入（每日行駛）'),
  ('422','自強 (3000)','13:53','13:55','樹林 → 新左營','每日行駛'),
  ('420','普悠瑪','14:51','14:52','樹林 → 臺東','每日行駛'),
  ('428','自強 (3000)','17:18','17:20','樹林 → 新左營','每日行駛'),
  ('432','自強 (3000)','18:13','18:15','樹林 → 新左營','每日行駛'),
  ('434','自強 (3000)','19:32','19:33','樹林 → 新左營','每日行駛'),
  ('442','自強 (3000)','20:28','20:30','樹林 → 臺東','每日行駛'),
  ('438','自強 (3000)','21:35','21:37','樹林 → 臺東','每日行駛'),
  ('448','普悠瑪','23:12','23:13','樹林 → 臺東','週末南下末班對號車')
on conflict (train_no) do nothing;
