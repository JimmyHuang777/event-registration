-- 60 報名截止日（先執行此 SQL，再 push 程式碼）
-- 空白＝不設截止。以 timestamptz 儲存，畫面以台灣時間輸入與顯示。
alter table events add column if not exists registration_deadline timestamptz;
comment on column events.registration_deadline is '報名截止時間；超過後不能新增報名或修改資料（仍可取消）。空白＝不限。';
