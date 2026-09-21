-- 会議録音に「文字起こしテキストの取り込み」経路を追加（T7b・2026-09-21）。
-- 他ツール（Notta / Zoom の文字起こし等）で既に文字起こし済みのテキストを貼り付けて、
-- 議事録生成→3データ提案→承認 の後段だけを使えるようにする。録音ファイルは無いので audio_url は null。
-- 既存の check 制約を置き換えるだけ（データ・他列は無変更）。
alter table meeting_recordings drop constraint if exists meeting_recordings_capture_check;
alter table meeting_recordings
  add constraint meeting_recordings_capture_check
  check (capture in ('pc_local','mobile_speaker','bot','text_import'));
