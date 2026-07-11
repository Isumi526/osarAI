-- 「自分をおさらいする」対話で、仕事/扱っている商品など構造化フィールドが
-- ノート(notes)としてしか保存されずjob/productsに反映されなかったバグの修正
-- (ウェルカム経由で回答済みの仕事内容が再度聞かれる不具合)。
-- 0011のappend_user_profile_notesを拡張し、notesの追記に加えて
-- 任意の構造化フィールド(job/products等のtop-levelキー)もアトミックにマージする。
-- 既存のappend_user_profile_notesはSettings等の既存呼び出し元互換のため残す。
create or replace function merge_user_profile_fields(new_notes text[], new_fields jsonb) returns void
language sql security invoker set search_path = public, pg_temp as $$
  update profiles
  set user_profile = (
    coalesce(user_profile, '{}'::jsonb)
    || coalesce(new_fields, '{}'::jsonb)
  ) || jsonb_build_object(
    'notes',
    coalesce(user_profile->'notes', '[]'::jsonb) || to_jsonb(coalesce(new_notes, '{}'::text[]))
  )
  where id = auth.uid();
$$;
