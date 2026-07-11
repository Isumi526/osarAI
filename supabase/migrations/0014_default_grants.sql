-- 【土台・着手時に判明した基盤issue】ローカルDB(supabase db reset)には、Supabase platformが
-- 通常プロジェクト作成時に自動付与する public スキーマの anon/authenticated への基本GRANTが
-- 一切適用されていなかった(0001〜0013のどの migration にも含まれず)。
-- そのため PostgREST 経由(anon key + ユーザーJWT)のテーブルアクセスが全て
-- 「permission denied for table ...」で失敗しており、既存のE2E(osarai-summary-edit.spec.ts等)も
-- 本タスク着手前から同じ理由でローカルでは通らない状態だった(本番相当のホスト型Supabaseは
-- プロジェクト作成時にplatform側でこれと同等のGRANTを自動付与するため影響を受けていないと
-- 見られる)。RLS(0002)が実質的なアクセス境界であり、GRANTは「そのロールがテーブルに触れる
-- 前提資格」を与えるだけなのでRLSの安全性は変わらない。今後作成されるテーブルにも及ぶよう
-- default privileges も設定する(Supabaseの標準ブートストラップと同内容)。
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;
