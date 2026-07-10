-- 「自分をおさらいする」対話結果(notes)の追記をアトミックにするRPC。
-- クライアント側のfetch→マージ→updateは読み取りと書き込みの間に競合状態があり
-- (Gemini独立レビュー指摘)、同時実行でnotesが失われる可能性があった。
-- 単一のUPDATE文でjsonb_set + 配列結合することで競合の余地を無くす。
-- security invoker(呼び出し元の権限で実行) = 既存のprofiles_updateポリシー
-- (id = auth.uid())がそのまま適用される。自分の行しか更新できない。
create or replace function append_user_profile_notes(new_notes text[]) returns void
language sql security invoker set search_path = public, pg_temp as $$
  update profiles
  set user_profile = jsonb_set(
    coalesce(user_profile, '{}'::jsonb),
    '{notes}',
    coalesce(user_profile->'notes', '[]'::jsonb) || to_jsonb(new_notes),
    true
  )
  where id = auth.uid();
$$;
