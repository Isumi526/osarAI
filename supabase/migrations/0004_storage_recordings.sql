-- 録音取り込み（サブ経路・§8-2/F-03）用の非公開ストレージバケット。
-- アクセスはサーバー側(service_role)経由のみ（アップロード・文字起こし・interaction作成）。
-- クライアントから直接は触らないため storage.objects への公開ポリシーは付けない。
-- ※サーバーの ensureRecordingsBucket でも冪等に作成する（このmigration未適用でも動く）。
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;
