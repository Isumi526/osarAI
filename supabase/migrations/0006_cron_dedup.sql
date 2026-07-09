-- おさらい促しcronの冪等化。Vercel Cronはat-least-once実行のため、
-- 稀な二重起動/リトライで同じユーザーに同日2回リマインドpushが飛ぶのを防ぐ
-- （Gemini独立レビュー指摘・T5）。job+日付の一意制約で1日1回に制限する。
create table cron_runs (
  job        text not null,
  run_date   date not null,
  created_at timestamptz not null default now(),
  primary key (job, run_date)
);
alter table cron_runs enable row level security;
revoke all on cron_runs from anon, authenticated;
