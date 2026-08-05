-- タスク管理機能（AIチャット一本化改修・2026-08-06）。AIチャットの発話から抽出される
-- 「スケジュール/つながり/タスク」3種のうちタスクの保存先。手動追加(タスク一覧画面)にも使う。
-- schedules(0008) と同じ org_id + owner_id=auth.uid() スコープのRLSパターンを踏襲。
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id),
  owner_id     uuid not null references profiles(id),
  customer_id  uuid references customers(id) on delete set null,
  title        text not null,
  due_at       timestamptz,
  status       text not null default 'open' check (status in ('open','done')),
  completed_at timestamptz,
  source       text not null default 'manual' check (source in ('manual','assistant')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on tasks(org_id);
create index on tasks(owner_id);
create index on tasks(customer_id);
create index on tasks(due_at);

alter table tasks enable row level security;

-- tasks: member=自分の分のみ / leader=同組織すべて閲覧可（schedules/customersと同じ方針）
create policy tasks_select on tasks for select
  using (
    org_id = current_org_id()
    and (current_user_role() = 'leader' or owner_id = auth.uid())
  );
create policy tasks_cud on tasks for all
  using (org_id = current_org_id() and owner_id = auth.uid())
  with check (org_id = current_org_id() and owner_id = auth.uid());

-- 統合AIチャットのセッション。osarai_sessions は単一customer前提のため流用しない。
-- 0025(accumulated_fields)の教訓を最初から適用し、ターン毎の抽出はサーバー側で累積して保持する。
create table assistant_sessions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id),
  user_id      uuid not null references profiles(id),
  messages     jsonb not null default '[]',   -- [{role, content}]
  accumulated  jsonb not null default '{}',   -- 抽出候補の累積 {people:[], schedules:[], tasks:[], self:{}}
  ai_chat_id   uuid references ai_chats(id),  -- consult発話のミラー保存先(Lightプラン上限カウント互換)
  status       text not null default 'in_progress'
               check (status in ('in_progress','reviewing','done')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on assistant_sessions(user_id);

alter table assistant_sessions enable row level security;
-- osarai_sessions/ai_chats と同じ「本人のみ」(0002 の osarai_own パターン)
create policy assistant_sessions_own on assistant_sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
