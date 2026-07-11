-- 予定に場所を追加(議事録要望・ユーザーごとの入力履歴からサジェストする用途)。
-- 追加のみ(ADD COLUMN)。履歴専用テーブルは設けず、既存scheduleの重複除去で簡易実装する。
alter table schedules add column location text;
