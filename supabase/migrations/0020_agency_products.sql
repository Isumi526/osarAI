-- 代理店(leader)が扱っている商品リストを作成し、紹介ユーザー(member)がアプリで
-- インポートできるようにする（議事録『review』回答A）。
-- 「代理店管理者ロール」は既存のprofiles.role='leader'を流用し、新規権限階層は追加しない
-- （決定と理由: 既にleader/memberロールが存在するため、新規ロール追加はRLS設計の複雑化に
-- 見合わない。既存roleの再利用でスコープを縮小した）。
create table agency_products (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  created_by  uuid not null references profiles(id),
  name        text not null,
  price       text,
  appeal      text,
  target      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on agency_products(org_id);

alter table agency_products enable row level security;

-- 閲覧: 同組織の全員(leader/member問わず)がインポート元として参照できる。
create policy agency_products_select on agency_products for select
  using (org_id = current_org_id());

-- 作成/更新/削除: leaderのみ(代理店管理者)。
create policy agency_products_cud on agency_products for all
  using (org_id = current_org_id() and current_user_role() = 'leader')
  with check (org_id = current_org_id() and current_user_role() = 'leader' and created_by = auth.uid());
