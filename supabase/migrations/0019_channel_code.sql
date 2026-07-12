-- チャネルコード(LP/signupリンクに埋め込む?code=、例: リベラルライフ用LL2026)を
-- 紹介コード(referred_by)と同様、signup時にユーザー情報へ持たせる。
-- referred_byは「誰が紹介したか」(profiles.idのUUID)を指すのに対し、
-- channel_codeは固定の販路/チャネル文字列であり別ユーザーを指さないため、
-- FKにせず自由記述textで保持する(Stripeのpromotion_code文字列と同一の値を想定)。
alter table profiles add column channel_code text;

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
    'member',                                          -- 既定ロール。leaderは手動付与
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    referrer_id,
    channel
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
