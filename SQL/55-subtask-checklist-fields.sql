-- 55：子項目新增欄位（檢核表格式：時間／地點／負責人／檢核人）
-- 可重複執行。
alter table public.task_subtask_templates add column if not exists time_label text;
alter table public.task_subtask_templates add column if not exists place      text;
alter table public.task_subtask_templates add column if not exists owner_note text;
alter table public.task_subtask_templates add column if not exists checker    text;

comment on column public.task_subtask_templates.time_label is '時間（例：一周前、07:00、畢班後）';
comment on column public.task_subtask_templates.place      is '地點';
comment on column public.task_subtask_templates.owner_note is '負責人（文字說明，例：佛堂組長）';
comment on column public.task_subtask_templates.checker    is '檢核人（文字說明，例：事務組長）';
