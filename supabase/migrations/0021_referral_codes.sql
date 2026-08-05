-- 代理店(leader)が紹介コード(例:LL2026)を管理できる画面のためのレジストリ（議事録『review』回答A）。
-- 【重要・スコープ判断】このテーブルはコードの「記録・使用状況の追跡」のみを担う。
-- Stripe側のCoupon/Promotion Codeの実際の発行はここでは行わない（CLAUDE.md §0 B-1の通り、
-- 運営者がStripe CLIで手動発行する運用を維持する）。理由: .envのSTRIPE_SECRET_KEYは
-- live modeであり、CCが自動テスト/実装検証の過程でStripe APIを叩いて実際の割引コードを
-- 作成するのは本番課金基盤への不可逆な副作用となるため避けた（要人力確認カテゴリ相当の判断）。
-- 発行済みのコード文字列(profiles.channel_codeとして既に収集されている)をleaderが一覧・
-- メモ付きで管理し、そのコード経由の登録者数を集計できるようにする。
create table referral_codes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  created_by  uuid not null references profiles(id),
  code        text not null,
  label       text,
  created_at  timestamptz not null default now(),
  unique (org_id, code)
);
create index on referral_codes(org_id);

alter table referral_codes enable row level security;

create policy referral_codes_select on referral_codes for select
  using (org_id = current_org_id());

create policy referral_codes_cud on referral_codes for all
  using (org_id = current_org_id() and current_user_role() = 'leader')
  with check (org_id = current_org_id() and current_user_role() = 'leader' and created_by = auth.uid());
