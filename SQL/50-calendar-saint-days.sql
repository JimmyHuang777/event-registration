-- 50: 行事曆新增「仙佛紀念日」分類（農曆日期、叩首禮）— 使用既有的 calendar_entries 資料表
alter table public.calendar_entries
  add column if not exists category text not null default 'entry',   -- 'entry' 一般行程 / 'saint' 仙佛紀念日
  add column if not exists lunar_text text,                          -- 農曆日期，例：正月初一
  add column if not exists kowtow text;                              -- 叩首禮，例：三跪九叩首
create index if not exists calendar_entries_category_idx on public.calendar_entries (category);
