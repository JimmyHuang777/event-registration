-- 64 LINE 通知（報名開放／截止前提醒／紀念日與初一十五提醒／額度與推送紀錄）
-- 先執行此 SQL，再 push 程式碼；可重複執行。

-- (1) 活動的通知勾選（預設兩個都開）
alter table events add column if not exists notify_on_open boolean not null default true;
alter table events add column if not exists notify_before_deadline boolean not null default true;
comment on column events.notify_on_open is '建立並啟用時，推送 LINE 給活動可見群組的成員（公開活動不推）。';
comment on column events.notify_before_deadline is '報名截止前一天，推送 LINE 給活動群組裡尚未報名的成員。';

-- (2) 紀念日／初一十五提醒設定（每種一列；預設啟用、提前 2 天、尚未勾選群組＝不發送）
create table if not exists notify_settings (
  kind        text primary key check (kind in ('saint_day', 'lunar_day')),
  enabled     boolean not null default true,
  lead_days   int not null default 2 check (lead_days between 1 and 30),
  group_ids   uuid[] not null default '{}',
  updated_at  timestamptz not null default now()
);
insert into notify_settings (kind) values ('saint_day'), ('lunar_day') on conflict (kind) do nothing;

-- (3) 推送紀錄（所有會推 LINE 的功能共用；dedupe_key 讓同一來源只推一次）
create table if not exists line_push_log (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,          -- event_open / deadline_eve / saint_day / lunar_day / dispatch / carpool_request
  ref         text,                   -- 活動 id、行事曆項目 id、日期…
  title       text,
  recipients  int not null default 0,
  sent        int not null default 0,
  status      text not null default 'claiming', -- sent / partial / failed / quota_blocked / no_token / no_recipients / claiming
  message     text,
  dedupe_key  text unique,
  created_at  timestamptz not null default now()
);
create index if not exists line_push_log_created_idx on line_push_log (created_at desc);

-- (4) LINE 額度狀態（只有一列；由 Edge Function 更新，Dashboard 顯示警示）
create table if not exists line_quota_status (
  id              int primary key default 1 check (id = 1),
  quota_limit     int,                -- 空＝不限量
  used            int,
  remaining       int,
  checked_at      timestamptz,
  last_problem    text,
  last_problem_at timestamptz
);
insert into line_quota_status (id) values (1) on conflict (id) do nothing;

alter table notify_settings    enable row level security;
alter table line_push_log      enable row level security;
alter table line_quota_status  enable row level security;
drop policy if exists "super admins manage notify_settings" on notify_settings;
create policy "super admins manage notify_settings" on notify_settings
  for all to authenticated using (is_super_admin()) with check (is_super_admin());
drop policy if exists "super admins read line_push_log" on line_push_log;
create policy "super admins read line_push_log" on line_push_log
  for select to authenticated using (is_super_admin());
drop policy if exists "super admins read line_quota_status" on line_quota_status;
create policy "super admins read line_quota_status" on line_quota_status
  for select to authenticated using (is_super_admin());
