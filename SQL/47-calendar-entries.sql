-- 47: 行事曆（純顯示用的行程）— 由 Dashboard 手動新增或從 Word 匯入
create table if not exists public.calendar_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  end_date date,                       -- 跨日行程的結束日，單日為 null
  title text not null,
  time_text text,                      -- 例：09:00–12:00（原樣文字）
  place text,
  notes text,
  source text,                         -- 匯入來源檔名（手動新增為 null）
  created_at timestamptz not null default now(),
  unique (entry_date, title)
);
create index if not exists calendar_entries_date_idx on public.calendar_entries (entry_date);

alter table public.calendar_entries enable row level security;

drop policy if exists "super admins manage calendar entries" on public.calendar_entries;
create policy "super admins manage calendar entries" on public.calendar_entries
  for all to authenticated
  using (is_super_admin())
  with check (is_super_admin());
-- 成員在 LINE 內的讀取走 calendar-api（service role），不需要開放匿名讀取。
