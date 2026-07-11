-- Stripe課金負債台帳 A2: webhookイベントの冪等化＋順序ガード。
-- Stripeはイベントを再送しうる（同一event.idの重複配信）ため処理済みidを記録して二重適用を防ぐ。
-- また checkout.session.completed の後段に届く customer.subscription.* が
-- 順序逆転（古いイベントが新しいイベントの後に届く）で状態を巻き戻さないよう、
-- 適用したイベントの発生時刻(event.created)を subscriptions 側にも保持する。

-- ========== Stripe webhookイベント冪等化テーブル ==========
-- サーバー(service_role)専用の内部テーブル。anon/authenticatedは一切触れない
-- （T9: LIFF/anonが触る必要がない新テーブル＝RLS ON＋revoke all from anon。
--   org_id概念を持たないグローバルなdedupテーブルのため、ポリシーは追加しない
--   ＝service_role(RLSバイパス)以外は完全に不可視/不可書き込み）。
create table stripe_webhook_events (
  id         text primary key,      -- Stripe event.id
  type       text not null,
  created_at timestamptz not null default now()
);
alter table stripe_webhook_events enable row level security;
revoke all on stripe_webhook_events from anon, authenticated;

-- ========== 順序ガード用カラム ==========
alter table subscriptions
  add column if not exists last_stripe_event_at timestamptz;
