-- 会議録音からの自動おさらい（Phase2・T0 土台）。
-- Zoom/Meet等の会議録音（PC透明ローカル録音 / スマホスピーカー録音 / 将来Bot）を
-- 録音ソース非依存で受け、長尺文字起こし→3データ提案→承認→登録 につなぐための状態保持テーブル。
-- 承認前の抽出候補(proposals)・議事録(minutes・T3で使用)・録音同意フラグ(consent_ack)を保持する。
-- 個人のAIログ扱いのため osarai_sessions / assistant_sessions と同じ「本人のみ」RLS(0002 osarai_own)を踏襲。
create table meeting_recordings (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id),
  user_id      uuid not null references profiles(id),
  -- 承認時に確定する「相手」。T4/T5で自動特定するまでは null 可（on delete set null）。
  customer_id  uuid references customers(id) on delete set null,
  -- 録音の入口（どの経路で録ったか）。interactions.source とは別軸で保持する。
  capture      text not null default 'pc_local'
               check (capture in ('pc_local','mobile_speaker','bot')),
  audio_url    text,                          -- Storage(recordings) の非公開パス
  mime_type    text,
  duration_sec integer,
  transcript   text,                          -- 全文文字起こし
  proposals    jsonb,                         -- 承認前の抽出候補 {people:[], schedules:[], tasks:[], self}
  minutes      text,                          -- ペラ一議事録（T3で生成・列だけ先に確保）
  -- 録音同意フラグ。ON/OFFの運用（透明録音の告知方針）は経営判断・後決め。列だけ確保。
  consent_ack  boolean not null default false,
  status       text not null default 'processing'
               check (status in ('processing','reviewing','done','failed')),
  error        text,                          -- status=failed の理由（文字起こし失敗等）
  committed_interaction_ids jsonb not null default '[]', -- 承認時に作成した interactions.id
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on meeting_recordings(user_id);
create index on meeting_recordings(customer_id);
create index on meeting_recordings(status);

alter table meeting_recordings enable row level security;

-- 本人のみ（leaderも他人の録音生ログは見ない・§7 osarai_own と同方針）。
-- テナント分離は最優先(CLAUDE.md)のため、本人限定に加え org_id も明示的に照合する
-- （user_id=auth.uid() で実質担保されるが、防御的に二重化する）。
create policy meeting_recordings_own on meeting_recordings for all
  using (user_id = auth.uid() and org_id = current_org_id())
  with check (user_id = auth.uid() and org_id = current_org_id());
