-- 49: 報名重複檢查改為只用「姓名」判斷（手機欄位已從畫面移除）
-- 「允許重複報名」功能已移除：所有活動，同一位用戶都不能用相同姓名再報名同一活動
-- （events.allow_duplicate_registration 欄位保留但不再使用）
create or replace function public.registrations_block_duplicates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.registrations r
    where r.event_id = new.event_id
      and r.user_id = new.user_id
      and r.status <> 'cancelled'
      and lower(btrim(r.attendee_name)) = lower(btrim(new.attendee_name))
  ) then
    raise exception '您已經用相同的姓名報名過此活動（本活動不開放重複報名）。' using errcode = '23505';
  end if;
  return new;
end $$;
