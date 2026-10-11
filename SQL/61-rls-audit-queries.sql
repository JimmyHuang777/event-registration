-- 61 權限檢查用查詢（只讀，不會改任何資料）。請分別執行，把結果貼回來。

-- (1) 沒有開啟 RLS 的資料表（匿名金鑰可直接讀寫！應該是空的，或只有刻意公開的表）
select c.relname as table_name
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
order by 1;

-- (2) 開了 RLS 但完全沒有 policy 的表（等於只有 service role 能用，通常是正確的）
select c.relname as table_name
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
order by 1;

-- (3) 匿名（anon）或所有人（public）可以執行的 public 函式
select p.proname as function_name, p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
order by 2 desc, 1;
