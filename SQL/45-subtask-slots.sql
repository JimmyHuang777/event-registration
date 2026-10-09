-- 45: 每個子項目各自的指派人數 (default 1)
-- 工作層級的「需求人數」不再使用；改為每個子項目設定 slots。

alter table public.task_subtask_templates
  add column if not exists slots integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_subtask_templates_slots_check') then
    alter table public.task_subtask_templates
      add constraint task_subtask_templates_slots_check check (slots >= 1);
  end if;
end $$;

-- 一個子項目現在可以有多位負責人：移除「同一場次同一子項目只能一列」的唯一限制，
-- 改為「同一人不能重複認領同一子項目」。
do $$
declare r record;
begin
  -- unique constraints on exactly (instance_id, subtask_template_id)
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.task_subtask_completions'::regclass
      and c.contype = 'u'
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(c.conkey) k
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)
          = array['instance_id','subtask_template_id']
  loop
    execute format('alter table public.task_subtask_completions drop constraint %I', r.conname);
  end loop;

  -- stand-alone unique indexes on exactly those columns
  for r in
    select ic.relname as idx
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = 'public.task_subtask_completions'::regclass
      and i.indisunique and not i.indisprimary
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(i.indkey) k
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k)
          = array['instance_id','subtask_template_id']
  loop
    execute format('drop index public.%I', r.idx);
  end loop;
end $$;

create unique index if not exists task_subtask_completions_one_per_person
  on public.task_subtask_completions (instance_id, subtask_template_id, assigned_user_id);
