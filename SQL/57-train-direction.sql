-- 57: 火車時刻表分去程（南下）與回程（北上）
--   去程 south：顯示「抵達瑞穗」時間（arrive_time）
--   回程 north：顯示「瑞穗出發」時間（depart_time）
-- 既有班次全部視為去程（原本資料都是南下）。回程班次請在 Dashboard「火車時刻」的「回程」頁新增。
alter table public.train_schedule
  add column if not exists direction text not null default 'south';

alter table public.train_schedule drop constraint if exists train_schedule_direction_check;
alter table public.train_schedule
  add constraint train_schedule_direction_check check (direction in ('south', 'north'));

-- 回程班次只需要出發時間，所以抵達時間改為可空（去程仍由程式檢查必填）
alter table public.train_schedule alter column arrive_time drop not null;

create index if not exists train_schedule_direction_idx on public.train_schedule (direction);
