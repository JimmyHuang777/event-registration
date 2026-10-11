-- 59 自動派工 Auto-dispatch  (先執行此 SQL，再 push 程式碼)
-- dispatch_rules : 派工規則（行事曆關鍵字／指定行事曆項目／仙佛紀念日／農曆初一十五）
-- dispatch_log   : 已派工紀錄（rule_id + source_key 唯一 → 不會重複派送）

create table if not exists dispatch_rules (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  kind              text not null check (kind in ('calendar_keyword','calendar_entry','saint_day','lunar_day')),
  keyword           text,                 -- calendar_keyword：標題包含；saint_day：留空＝全部紀念日
  calendar_entry_id uuid references calendar_entries(id) on delete cascade,  -- calendar_entry
  lunar_days        int[] not null default '{}',   -- lunar_day：{1,15}
  lead_days         int  not null default 3 check (lead_days between 0 and 365),
  template_event_id uuid references events(id) on delete set null,  -- 複製此活動當報名表範本（空＝不建報名表）
  event_group_ids   uuid[] not null default '{}',  -- 新活動可見群組（空＝沿用範本活動的群組）
  preset_ids        uuid[] not null default '{}',  -- 工作清單（task_job_presets.id）
  group_ids         uuid[] not null default '{}',  -- 派工群組（空＝沿用各工作清單自己的群組）
  notify            boolean not null default true, -- 建立後推送 LINE
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

create table if not exists dispatch_log (
  id             uuid primary key default gen_random_uuid(),
  rule_id        uuid not null references dispatch_rules(id) on delete cascade,
  source_key     text not null,          -- entry:<id> 或 lunar:<yyyy-mm-dd>
  source_date    date not null,
  source_title   text,
  event_id       uuid,
  template_ids   uuid[] not null default '{}',
  notified_count int not null default 0,
  status         text not null default 'ok',
  message        text,
  created_at     timestamptz not null default now(),
  unique (rule_id, source_key)
);
create index if not exists dispatch_log_created_idx on dispatch_log(created_at desc);

alter table dispatch_rules enable row level security;
alter table dispatch_log   enable row level security;
drop policy if exists "super admins manage dispatch_rules" on dispatch_rules;
create policy "super admins manage dispatch_rules" on dispatch_rules
  for all to authenticated using (is_super_admin()) with check (is_super_admin());
drop policy if exists "super admins manage dispatch_log" on dispatch_log;
create policy "super admins manage dispatch_log" on dispatch_log
  for all to authenticated using (is_super_admin()) with check (is_super_admin());
