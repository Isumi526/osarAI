-- フェーズ3 Auth: アンカーテナント(LL)をseed＋新規auth.userのprofile自動作成。
-- 方針（確定）：MVPの新規サインアップは全員 LiberalLIFE 組織に member として所属。
-- 他組織展開は後フェーズ（招待/別org作成ロジックを追加）で解放する。

-- LL組織（固定UUIDでseed・冪等）
insert into organizations (id, name)
values ('11111111-1111-4111-8111-111111111111', 'LiberalLIFE')
on conflict (id) do nothing;

-- auth.users 作成時に profiles を自動生成（RLSをバイパスするため security definer）
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, org_id, role, display_name)
  values (
    new.id,
    '11111111-1111-4111-8111-111111111111',          -- LL組織に所属
    'member',                                          -- 既定ロール。leaderは手動付与
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
