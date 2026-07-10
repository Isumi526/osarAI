-- 紹介コード機能。各ユーザーが自分のprofiles.idから決定的に導出したコードを
-- 発行でき、そのコード付きのURL(?ref=CODE)経由でLP→signupと引き継がれた
-- 相手が登録すると、referred_byにその紹介者を記録する。
-- 別テーブルは持たず、handle_new_user()トリガー内でraw_user_meta_data->>'ref'
-- (signup時にoptions.dataで渡す)をprofiles.idの先頭一致で解決する。
-- 不正/存在しないコードは静かに無視(referred_by=null)。自己紹介は新規プロフィールが
-- まだ存在しない時点でのlookupのため構造的に発生しない。
alter table profiles add column referred_by uuid references profiles(id);

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ref_code text := lower(coalesce(new.raw_user_meta_data->>'ref', ''));
  referrer_id uuid;
begin
  if length(ref_code) >= 6 then
    select id into referrer_id
    from profiles
    where replace(id::text, '-', '') like (ref_code || '%')
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
