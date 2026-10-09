-- =========================================================
-- 54 檢查「因為是組長而被自動加進全域任務管理員」的人
-- （只查詢，不會刪除任何資料）
--
-- 階段二之後，佛堂/庶務/住壇組長只能管理自己壇・組的工作。
-- 但舊版在新增組長時，會把他們一併加入全域 task_job_admins，
-- 留在名單內的人仍可管理「全部」工作。
-- 下列清單 = 目前是組長、且同時在全域名單內的人。
-- 若確定不再需要全域權限，請到 Dashboard「管理者權限」取消其「任務」勾選
-- （或用最下方註解的語法）。你手動加入的人（非組長）不會出現在這裡。
-- =========================================================
select u.id as user_id,
       u.display_name,
       a.name as altar,
       m.team
from public.altar_team_members m
join public.task_job_admins j on j.user_id = m.user_id
join public.users u on u.id = m.user_id
left join public.altars a on a.id = m.altar_id
where m.role = 'leader'
  and m.team in ('shrine', 'general', 'resident')
order by u.display_name, a.name;

-- 確認名單後，若要全數移除，取消下列註解再執行：
-- delete from public.task_job_admins
-- where user_id in (
--   select m.user_id from public.altar_team_members m
--   where m.role = 'leader' and m.team in ('shrine','general','resident')
-- );
