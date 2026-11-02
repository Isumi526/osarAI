-- 録音の保存方針（2026-11-02）：会議ごとに音声を聞き返し・消せるようにする。
-- 2トラック録音（2026-09-22）の「自分（マイク）」側のファイルはこれまで DB に記録しておらず、
-- 会議ごとに消す時に見つけられなかった。相手側（audio_url）と同じく Storage の非公開パスを残す。
alter table meeting_recordings add column if not exists self_audio_url text;
