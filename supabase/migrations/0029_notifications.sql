-- アプリ内通知（2026-09-08）。ベルアイコン＋未読バッジ＋2タブの通知一覧の保存先。
--
-- 由来（2026-08-01 議事録の逐語）: 「アプリ内通知という言葉を使いましたけど、まあ、通知ですね」
-- ＝ゆくゆくはプッシュ通知・LINE連携へ広げる意図。そのため category は
-- 「どう届けるか(チャネル)」ではなく「何の通知か(中身)」で切り、配信チャネルが
-- 増えてもこのテーブルをそのまま使えるようにする。
--
-- category:
--   announce … お知らせ（開発者からの配信）。運営が service_role で入れる。
--   reminder … 発話から拾った約束・予定・目標のリマインド、タスクの期限（まもなく/超過）。
--               生成側は別チケット（約束の通知 / タスク期限通知）が担当する。
--
-- RLS は本人のみ（push_tokens と同じ方針）。leader も他人の通知は見ない
-- ＝通知は個人宛の連絡であり、顧客データのような組織資産ではないため。
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  user_id     uuid not null references profiles(id) on delete cascade,
  category    text not null check (category in ('announce','reminder')),
  title       text not null,
  body        text,
  -- 通知から飛ばしたいアプリ内のパス（例 /tasks, /customers/<id>）。外部URLは入れない。
  link_path   text,
  -- 通知の元になったデータ（あれば）。消えても通知自体は残す（履歴として読めるように）。
  customer_id uuid references customers(id) on delete set null,
  task_id     uuid references tasks(id) on delete set null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index on notifications(user_id);
create index on notifications(org_id);
-- 一覧は「本人の・カテゴリ別・新しい順」で引くのでその形に合わせる
create index on notifications(user_id, category, created_at desc);
-- 未読バッジは件数だけを頻繁に引くので部分インデックスにする
create index on notifications(user_id) where read_at is null;

alter table notifications enable row level security;

-- 本人のみ参照。leader も他人の通知は見ない。
-- テナント分離は最優先(CLAUDE.md)のため、本人限定に加え org_id も明示的に照合する
-- （user_id=auth.uid() で実質担保されるが、0028 と同じく防御的に二重化する）。
create policy notifications_select on notifications for select
  using (user_id = auth.uid() and org_id = current_org_id());

-- 本人ができるのは既読にすることだけ。作成・削除はサーバー(service_role)が行う
-- ＝クライアントから任意の通知を作れると「お知らせ」を偽装できてしまうため。
create policy notifications_update on notifications for update
  using (user_id = auth.uid() and org_id = current_org_id())
  with check (user_id = auth.uid() and org_id = current_org_id());
