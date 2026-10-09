-- =========================================================
-- 56 壇各組：工作細則（6W簡流表）、交接項目、整組對調
-- 可重複執行。資料由 altar-team-api（service role）讀寫；
-- Dashboard 以超級管理員身分直接讀寫。
-- =========================================================

-- 工作細則：每組可有多份簡流表，每份對應一個工作項目（例：點傳師接待）
create table if not exists public.altar_team_rules (
  id          uuid primary key default gen_random_uuid(),
  altar_id    uuid not null references public.altars(id) on delete cascade,
  team        text not null,
  title       text not null,
  owners      text,                       -- 簡流表上的負責人姓名（文字）
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists altar_team_rules_idx on public.altar_team_rules (altar_id, team, sort_order);

-- 簡流表的每一列：時(When) 事(What) 人(Who) 地(Where) 物(How) 備註(Why)
create table if not exists public.altar_team_rule_rows (
  id          uuid primary key default gen_random_uuid(),
  rule_id     uuid not null references public.altar_team_rules(id) on delete cascade,
  when_text   text,
  what_text   text,
  who_text    text,
  where_text  text,
  how_text    text,
  why_text    text,
  sort_order  int not null default 0
);
create index if not exists altar_team_rule_rows_idx on public.altar_team_rule_rows (rule_id, sort_order);

-- 交接項目：每組一份清單，換組時逐項確認
create table if not exists public.altar_team_handover_items (
  id           uuid primary key default gen_random_uuid(),
  altar_id     uuid not null references public.altars(id) on delete cascade,
  team         text not null,
  title        text not null,
  note         text,
  sort_order   int not null default 0,
  confirmed_at timestamptz,
  confirmed_by uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists altar_team_handover_idx on public.altar_team_handover_items (altar_id, team, sort_order);

-- 整組對調申請（兩組成員互換；對方組長同意後才執行）
create table if not exists public.altar_team_swaps (
  id              uuid primary key default gen_random_uuid(),
  altar_id        uuid not null references public.altars(id) on delete cascade,
  team_a          text not null,
  team_b          text not null,
  include_leaders boolean not null default true,
  requested_by    uuid references public.users(id) on delete set null,
  status          text not null default 'pending',   -- pending | accepted | declined | cancelled
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid references public.users(id) on delete set null
);
create index if not exists altar_team_swaps_idx on public.altar_team_swaps (altar_id, status, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['altar_team_rules','altar_team_rule_rows','altar_team_handover_items','altar_team_swaps'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "super admins manage %I" on public.%I', t, t);
    execute format('create policy "super admins manage %I" on public.%I for all to authenticated using (is_super_admin()) with check (is_super_admin())', t, t);
  end loop;
end $$;
