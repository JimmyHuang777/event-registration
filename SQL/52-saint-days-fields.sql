-- 52: 仙佛紀念日可在 Dashboard 新增／修改／刪除 — 拆開存聖號與聖誕／成道
alter table public.calendar_entries
  add column if not exists saint_name text,   -- 仙佛聖號，例：彌勒祖師
  add column if not exists saint_type text;   -- 聖誕／成道

-- 既有的仙佛紀念日（標題為「聖號 聖誕」）補上拆開後的欄位
update public.calendar_entries
set saint_name = regexp_replace(btrim(title), '\s+\S+$', ''),
    saint_type = substring(btrim(title) from '\S+$')
where category = 'saint' and saint_name is null and btrim(title) ~ '\s';

update public.calendar_entries
set saint_name = btrim(title)
where category = 'saint' and saint_name is null;
