-- 【要設計判断】代理店(LL)とリーダー課金プランを別アクターとして再設計する（回答A）。
-- 従来の前提の誤り: リベラルライフ(LL)はosarAIの営業代理店そのものであり、
-- profiles/subscriptionsを持つ「ユーザー」ではない(できることは①紹介コード管理
-- ②そのコード経由の登録者閲覧のみ)。「リーダー」は既存profiles.role='leader'の
-- ような役割フラグではなく、新しい課金プラン(招待した相手を無料のmemberプランで
-- 使わせ、自分の商品リストをインポートさせられる)。0020(agency_products)/
-- 0021・0022(referral_codes)はこの誤った前提(profiles.role='leader'の流用)で
-- 実装されていたため、正しいアクターモデルに合わせて修正する。

-- 1. LL(代理店)用の新ロール。billing gate対象外・紹介コード管理専用アクター。
alter table profiles drop constraint profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('member', 'leader', 'agency'));

-- 2. 「リーダー」課金プラン(招待元)と「メンバー」課金プラン(招待された側・無料)を追加。
--    既存のprofiles.role='leader'(リーダー集約ビューF-05用の役割フラグ)とは別概念。
--    昇格は既存のprofiles.role='leader'同様、当面は運営者がDBを手動更新する運用
--    (実際のStripe Price作成・自己申込チェックアウト導線は本チケットのスコープ外。
--    価格未確定のため、自己申込フローを作る前に運営者の価格判断が必要)。
alter table subscriptions drop constraint subscriptions_plan_check;
alter table subscriptions add constraint subscriptions_plan_check check (plan in ('light', 'standard', 'pro', 'leader', 'member'));

-- 3. リーダー判定ヘルパ(RLSから利用)。
create or replace function is_active_leader(uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(
    select 1 from subscriptions
    where user_id = uid and plan = 'leader' and status in ('trialing', 'active')
  );
$$;

-- 4. 新規signupの招待元(referred_by)が有効なリーダープラン契約者なら、
--    Stripeを一切経由せず無料の'member'プランを自動発行する。
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ref_code text := lower(coalesce(new.raw_user_meta_data->>'ref', ''));
  referrer_id uuid;
  channel text := nullif(new.raw_user_meta_data->>'code', '');
begin
  if length(ref_code) >= 12 then
    select id into referrer_id
    from profiles
    where left(replace(id::text, '-', ''), 12) = left(ref_code, 12)
    limit 1;
  end if;

  insert into public.profiles (id, org_id, role, display_name, referred_by, channel_code)
  values (
    new.id,
    '11111111-1111-4111-8111-111111111111',          -- LL組織に所属
    'member',                                          -- 既定ロール。leader/agencyは手動付与
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    referrer_id,
    channel
  )
  on conflict (id) do nothing;

  if referrer_id is not null and is_active_leader(referrer_id) then
    insert into public.subscriptions (user_id, plan, status)
    values (new.id, 'member', 'active')
    on conflict (user_id) do nothing;
  end if;

  return new;
end;
$$;

-- 5. agency_products: 作成/更新/削除は「有効なリーダープラン契約者」本人のみ
--    (旧: 同組織のprofiles.role='leader'なら誰でも)。
--    閲覧は自分の商品(リーダー本人) または 自分を招待したリーダーの商品(メンバー)のみ
--    (旧: 同組織全員に対しorg全体スコープで公開していたのが誤りだった)。
drop policy agency_products_select on agency_products;
drop policy agency_products_cud on agency_products;

create policy agency_products_select on agency_products for select
  using (
    org_id = current_org_id()
    and (
      created_by = auth.uid()
      or created_by = (select referred_by from profiles where id = auth.uid())
    )
  );

create policy agency_products_cud on agency_products for all
  using (org_id = current_org_id() and is_active_leader(auth.uid()) and created_by = auth.uid())
  with check (org_id = current_org_id() and is_active_leader(auth.uid()) and created_by = auth.uid());

-- 6. referral_codes: 作成/更新/削除はLL(agencyロール)本人のみ(旧: profiles.role='leader')。
--    閲覧は従来どおり同組織全員に開放のまま変更しない(閲覧範囲の誤りは指摘されていない)。
drop policy referral_codes_cud on referral_codes;

create policy referral_codes_cud on referral_codes for all
  using (org_id = current_org_id() and current_user_role() = 'agency' and created_by = auth.uid())
  with check (org_id = current_org_id() and current_user_role() = 'agency' and created_by = auth.uid());
