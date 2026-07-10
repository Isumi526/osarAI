-- スケジュール管理機能（月/週/日カレンダー・顧客紐付け・終了時おさらい通知）。
-- 議事録『202707亥角レビュー①』より。要判断チケットで実装(A)の回答を得て新規追加。
-- customers/interactions と同じ owner_id=auth.uid() スコープのRLSパターンを踏襲。
create table schedules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  owner_id    uuid not null references profiles(id),
  customer_id uuid references customers(id) on delete set null,
  title       text not null,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  reminded_at timestamptz,     -- 終了時刻の「おさらいしませんか」通知を送信済みならセット（冪等化）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on schedules(org_id);
create index on schedules(owner_id);
create index on schedules(customer_id);
create index on schedules(start_at);

alter table schedules enable row level security;

-- schedules: member=自分の分のみ / leader=同組織すべて閲覧可（customers/interactionsと同じ方針）
create policy schedules_select on schedules for select
  using (
    org_id = current_org_id()
    and (current_user_role() = 'leader' or owner_id = auth.uid())
  );
create policy schedules_cud on schedules for all
  using (org_id = current_org_id() and owner_id = auth.uid())
  with check (org_id = current_org_id() and owner_id = auth.uid());
