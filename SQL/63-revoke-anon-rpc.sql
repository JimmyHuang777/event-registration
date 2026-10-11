-- 63 關閉匿名可呼叫的內部函式（依 SQL 61 查詢結果）  可重複執行
-- 原因：Supabase 預設讓匿名金鑰（Dashboard 原始碼中可見）能呼叫 public 函式。
--   ensure_task_instances / ensure_meeting_instances 是 SECURITY DEFINER，
--   任何人用匿名金鑰就能要求產生任意日期範圍的工作／會議場次（資料庫灌水）。
-- 這些函式只被 Edge Function（service_role）與 Dashboard（已登入的 authenticated）呼叫，所以只關匿名。
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('ensure_task_instances', 'ensure_meeting_instances', 'is_altar_visible_to_user', 'altar_and_descendants')
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;
-- 保留不動：is_super_admin、has_event_role（RLS 政策會用，匿名呼叫只會得到 false）；
--   registrations_block_duplicates、rls_auto_enable（觸發器函式，無法被直接呼叫）。
-- 還原：grant execute on function public.ensure_task_instances(date, date) to anon;（其餘同理）
