-- osarAI RLSポリシー（CLAUDE.md §7）。全テーブルでRLS有効化。テナント分離が最優先。
--
-- 【設計書からの修正点】
--  §7の helper 関数 current_role() は PostgreSQL の予約語 current_role
--  （SQL標準の組み込み = セッションロールを返す）と衝突する。そのまま定義/呼出すると
--  leader 判定が意図通り動かず権限分離が壊れる恐れがあるため、current_user_role() に改名。
--  また security definer 関数は search_path を固定（Supableリンタ警告・関数注入対策）。

-- 現在ユーザーの org_id / role を引くヘルパ
create or replace function current_org_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select org_id from profiles where id = auth.uid()
$$;

create or replace function current_user_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from profiles where id = auth.uid()
$$;

-- 有効化
alter table organizations   enable row level security;
alter table profiles         enable row level security;
alter table customers        enable row level security;
alter table interactions     enable row level security;
alter table osarai_sessions  enable row level security;
alter table ai_chats         enable row level security;
alter table ai_chat_messages enable row level security;
alter table subscriptions    enable row level security;
alter table push_tokens      enable row level security;

-- organizations: 自組織のみ
create policy org_select on organizations for select
  using (id = current_org_id());

-- profiles: 同組織は参照可（リーダーが配下を見るため）、本人のみ更新
create policy profiles_select on profiles for select
  using (org_id = current_org_id());
create policy profiles_update on profiles for update
  using (id = auth.uid());

-- customers: member=自分のowner分のみ / leader=同組織すべて
create policy customers_select on customers for select
  using (
    org_id = current_org_id()
    and (current_user_role() = 'leader' or owner_id = auth.uid())
  );
create policy customers_cud on customers for all
  using (org_id = current_org_id() and owner_id = auth.uid())
  with check (org_id = current_org_id() and owner_id = auth.uid());

-- interactions: 同上（leaderは同組織閲覧、memberは自分の顧客分）
create policy interactions_select on interactions for select
  using (
    org_id = current_org_id()
    and (current_user_role() = 'leader' or author_id = auth.uid())
  );
create policy interactions_cud on interactions for all
  using (org_id = current_org_id() and author_id = auth.uid())
  with check (org_id = current_org_id() and author_id = auth.uid());

-- osarai_sessions / ai_chats: 本人のみ（leaderも他人の対話ログは見ない）
create policy osarai_own on osarai_sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy aichats_own on ai_chats for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy aichatmsg_own on ai_chat_messages for all
  using (exists (select 1 from ai_chats c where c.id = chat_id and c.user_id = auth.uid()))
  with check (exists (select 1 from ai_chats c where c.id = chat_id and c.user_id = auth.uid()));

-- subscriptions / push_tokens: 本人のみ
-- （subscriptions はサーバーの service_role が RLS をバイパスして更新。§7注記）
create policy subs_own on subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_own on push_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
