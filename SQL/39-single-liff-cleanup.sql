-- =========================================================
-- 39-single-liff-cleanup.sql
-- Run ONLY AFTER: (1) Dashboard + create-liff-app deployed and Home link
-- regenerated, (2) all pages deployed and Home opens/works via the new link.
-- Keeps the single 'home' LIFF app; removes every other registered app row.
-- =========================================================

-- See what will be removed (write these IDs down; delete those LIFF apps
-- in LINE Developers Console afterwards to free slots):
select purpose, liff_id from liff_apps where purpose <> 'home' order by purpose;

delete from liff_apps where purpose <> 'home';

update events set liff_id = null where liff_id is not null;
update altars set liff_id = null where liff_id is not null;

select * from liff_apps;  -- should show only 'home'
