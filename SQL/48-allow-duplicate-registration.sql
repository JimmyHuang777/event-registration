-- 48: 每個活動可設定「允許同一位用戶重複報名」(預設：不允許)
alter table public.events
  add column if not exists allow_duplicate_registration boolean not null default false;

-- 1) 移除 registrations 上既有、會擋住「相同資料再報名」的唯一限制
--    （只處理欄位全部落在 event_id / user_id / attendee_name / attendee_phone 內的唯一限制，主鍵不動）
do $$
declare r record;
begin
  for r in
    select c.conname as name
    from pg_constraint c
    where c.conrelid = 'public.registrations'::regclass
      and c.contype = 'u'
      and not exists (
        select 1 from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
        where a.attname::text <> all (array['event_id','user_id','attendee_name','attendee_phone'])
      )
  loop
    raise notice 'dropping unique constraint %', r.name;
    execute format('alter table public.registrations drop constraint %I', r.name);
  end loop;

  for r in
    select ic.relname as name
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = 'public.registrations'::regclass
      and i.indisunique and not i.indisprimary
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
      and not exists (
        select 1 from unnest(i.indkey) k
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k
        where a.attname::text <> all (array['event_id','user_id','attendee_name','attendee_phone'])
      )
  loop
    raise notice 'dropping unique index %', r.name;
    execute format('drop index public.%I', r.name);
  end loop;
end $$;

-- 2) 改由觸發器依活動設定決定：不允許時，同一位用戶不能用相同姓名＋電話再報名同一活動
create or replace function public.registrations_block_duplicates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.events e where e.id = new.event_id and e.allow_duplicate_registration) then
    return new;
  end if;
  if exists (
    select 1 from public.registrations r
    where r.event_id = new.event_id
      and r.user_id = new.user_id
      and r.status <> 'cancelled'
      and lower(btrim(r.attendee_name)) = lower(btrim(new.attendee_name))
      and coalesce(btrim(r.attendee_phone), '') = coalesce(btrim(new.attendee_phone), '')
  ) then
    raise exception '您已經用相同的姓名與電話報名過此活動（本活動不開放重複報名）。' using errcode = '23505';
  end if;
  return new;
end $$;

drop trigger if exists registrations_block_duplicates_trg on public.registrations;
create trigger registrations_block_duplicates_trg
  before insert on public.registrations
  for each row execute function public.registrations_block_duplicates();
