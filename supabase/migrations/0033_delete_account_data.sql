-- 退会（アカウント削除）のデータ削除（2026-09-28・人判断: 窓口への連絡ではなくアプリ内で退会できるようにする）。
-- ユーザーに紐付く表の多くは profiles への外部キーが NO ACTION（消しても連鎖しない）なので、
-- 依存の深い順に1トランザクションで消す。auth.users の削除（→ profiles 以下が CASCADE）は
-- サーバー（/api/account/delete）が Supabase の管理 API で行う。録音音声（Storage）の削除もサーバー側。
--
-- service_role からのみ呼べる（本人の JWT からは呼べない＝任意のユーザーを消せない）。
create or replace function public.delete_account_data(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 自分が紹介した人の「紹介元」は外す（紹介された人のアカウントは残す）
  update profiles set referred_by = null where referred_by = p_user;

  delete from notifications       where user_id  = p_user;
  delete from tasks               where owner_id = p_user;
  delete from schedules           where owner_id = p_user;
  delete from meeting_recordings  where user_id  = p_user;
  delete from assistant_sessions  where user_id  = p_user;
  delete from osarai_sessions     where user_id  = p_user;
  delete from ai_chats            where user_id  = p_user;  -- ai_chat_messages は CASCADE
  delete from interactions        where author_id = p_user;
  delete from customers           where owner_id = p_user;  -- 残りの interactions は CASCADE
  delete from push_tokens         where user_id  = p_user;
  delete from subscriptions       where user_id  = p_user;
end;
$$;

revoke all on function public.delete_account_data(uuid) from public;
revoke all on function public.delete_account_data(uuid) from anon, authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;
