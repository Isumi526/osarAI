-- おさらい対話で判明した顧客の構造化情報(custom_fields)を、セッション単位でターンをまたいで
-- 累積するための列。追加のみ（既存データ・既存挙動に影響なし）。
--
-- 背景: Geminiは毎ターン対話履歴全体から再抽出するが、ターンによって custom_fields の
-- 一部（age/gender等）を落として返すことがある。保存されるのは最終ターンの抽出結果のみで、
-- 既存顧客は merge_customer_custom_fields(0023) で守られていたが、
-- 新規顧客の作成時は最終ターンの結果をそのまま insert するため、落ちた項目が失われていた
-- （2026-08-05 の人力レビューで実際に発生: 対話中に「30代の女性」「保険」と話したのに
-- 作成された顧客カードの custom_fields が {} になった）。
-- 各ターンでここへマージし、完了時はこの累積値を使うことで取りこぼしをなくす。
alter table osarai_sessions
  add column if not exists accumulated_fields jsonb not null default '{}'::jsonb;
