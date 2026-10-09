-- =========================================================
-- 40-personal-profile.sql
-- Personal info (個人資訊) + family/friend info (親友資訊).
-- Accessed only through the profile-api edge function (service role),
-- so RLS is enabled with no public policies.
-- =========================================================

create table if not exists user_profiles (
  user_id    uuid primary key references users(id) on delete cascade,
  altar_name text,                       -- 壇
  full_name  text not null,              -- 姓名
  gender     text check (gender in ('乾','坤','童','女')),  -- 性別
  duty       text,                       -- 天職
  shrine     text,                       -- 佛堂
  phone      text,                       -- 電話
  updated_at timestamptz not null default now()
);

create table if not exists family_members (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  relationship text not null,            -- 與您的關係
  altar_name   text,
  full_name    text not null,
  gender       text check (gender in ('乾','坤','童','女')),
  duty         text,
  shrine       text,
  phone        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists family_members_user_idx on family_members(user_id);

alter table user_profiles  enable row level security;
alter table family_members enable row level security;

select 'ok' as result;
