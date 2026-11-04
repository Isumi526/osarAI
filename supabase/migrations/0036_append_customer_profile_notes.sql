-- つながりのメモ（customers.profile_notes）へ、AI が新しく分かったことだけを追記する（2026-11-05 人判断「AI も書き足す」）。
-- 0035 の append_profile_text と同じく単一の UPDATE で追記し、読み取りと書き込みの間の競合で失われないようにする。
-- security invoker = customers_cud ポリシーがそのまま効く。owner_id も絞り、自分のつながりしか更新できない。
create or replace function append_customer_profile_notes(target_customer_id uuid, addition text) returns void
language sql security invoker set search_path = public, pg_temp as $$
  update customers
  set profile_notes = case
        when coalesce(trim(profile_notes), '') = '' then trim(addition)
        else profile_notes || E'\n' || trim(addition)
      end,
      updated_at = now()
  where id = target_customer_id and owner_id = auth.uid() and coalesce(trim(addition), '') <> '';
$$;
