-- 紹介コード解決の改善(Gemini独立レビュー指摘への対応)。
-- 1) 0009のreplace(id::text,'-','') like (code||'%') は非インデックスの前方一致検索で、
--    signup経路(未認証から実行される)にとって負荷懸念があった。式インデックスを追加し、
--    等価比較(=)で引けるようクエリを書き換える。
-- 2) コード長8文字(32bit)は将来のユーザー数増加で衝突確率が無視できなくなるため12文字
--    (48bit)に拡張し、衝突時に誤った紹介者へ紐付くリスクを大幅に低減する。
create index if not exists profiles_referral_lookup_idx
  on profiles (left(replace(id::text, '-', ''), 12));

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ref_code text := lower(coalesce(new.raw_user_meta_data->>'ref', ''));
  referrer_id uuid;
begin
  if length(ref_code) >= 12 then
    select id into referrer_id
    from profiles
    where left(replace(id::text, '-', ''), 12) = left(ref_code, 12)
    limit 1;
  end if;

  insert into public.profiles (id, org_id, role, display_name, referred_by)
  values (
    new.id,
    '11111111-1111-4111-8111-111111111111',          -- LL組織に所属
    'member',                                          -- 既定ロール。leaderは手動付与
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    referrer_id
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
